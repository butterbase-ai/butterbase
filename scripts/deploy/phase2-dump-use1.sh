#!/usr/bin/env bash
# Phase 2 cutover dump+restore: prod control DB → runtime-use1.
#
# Uses the FULL RUNTIME_TABLES list from scripts/migrate-runtime-data.ts
# (38 tables — includes app_db_connections, agents/agent_*, partner_*,
# dispatcher_cursors that the move-app saga subset omits).
#
# audit_events is NOT in this list — per the spec, it splits by actor_type
# at write time; historical rows stay on platform DB.
#
# Idempotent: TRUNCATEs use1 first. Safe to re-run for cutover rehearsal.
#
# Required env:
#   PROD_READONLY_URL  - prod control DB (RW or RO branch both fine)
#   RUNTIME_USE1_URL   - destination

set -euo pipefail

: "${PROD_READONLY_URL:?Missing PROD_READONLY_URL}"
: "${RUNTIME_USE1_URL:?Missing RUNTIME_USE1_URL}"

PG_DUMP=/opt/homebrew/opt/libpq/bin/pg_dump
PSQL=/opt/homebrew/opt/libpq/bin/psql
DUMP_FILE=/tmp/butterbase-phase2-use1.sql

# 38 tables from scripts/migrate-runtime-data.ts RUNTIME_TABLES.
# Order is FK-aware (parents before children for same-tier FKs).
TABLES=(
  apps
  app_db_connections
  app_users app_refresh_tokens app_verification_codes app_signing_keys
  app_oauth_configs app_connected_accounts oauth_states
  app_custom_domains
  app_frontend_env_vars app_do_env_vars
  app_durable_objects app_do_deploy_state
  app_edge_ssr_deployments
  app_functions function_triggers function_invocations
  app_realtime_config app_integration_configs
  app_orders app_plans app_products app_subscriptions
  agents agent_mcp_servers agent_runs agent_run_events agent_checkpoints
  agent_tool_audits agent_usage agent_webhook_deliveries
  partner_keys partner_pools partner_proxy_logs
  mcp_tool_call_log ai_usage_logs dispatcher_cursors
  storage_objects
  app_deployments neon_tasks rag_ingestion_queue
  usage_meters
)

echo "=== Phase 2 dump+restore: prod control → runtime-use1 ==="
echo "Tables: ${#TABLES[@]}"

# Pre-flight: source counts (per-connection, no long-lived idle)
echo ""
echo "-- 1. source row counts (38 tables) --"
SOURCE_COUNT_SQL=$(for t in "${TABLES[@]}"; do echo "SELECT '$t' AS t, count(*) FROM $t UNION ALL"; done | sed '$ s/UNION ALL$//')
"$PSQL" "$PROD_READONLY_URL" -t -A -F'|' -c "$SOURCE_COUNT_SQL ORDER BY 1" 2>&1 | tee /tmp/source-counts.txt | head -40
echo "  total source rows: $(awk -F'|' '{s+=$2}END{print s}' /tmp/source-counts.txt)"

# Truncate destination
echo ""
echo "-- 2. truncate runtime-use1 (clean slate) --"
TRUNC_LIST=$(printf "%s," "${TABLES[@]}" | sed 's/,$//')
"$PSQL" "$RUNTIME_USE1_URL" -v ON_ERROR_STOP=1 -c "TRUNCATE TABLE ${TRUNC_LIST} RESTART IDENTITY CASCADE" 2>&1 | tail -3

# pg_dump
echo ""
echo "-- 3. pg_dump --data-only (parallel-safe; all 38 tables) --"
DUMP_ARGS=()
for t in "${TABLES[@]}"; do DUMP_ARGS+=(-t "public.$t"); done
time "$PG_DUMP" "$PROD_READONLY_URL" \
  --data-only --no-owner --no-privileges \
  "${DUMP_ARGS[@]}" \
  -f "$DUMP_FILE"
echo "  dump: $(wc -c < "$DUMP_FILE" | tr -d ' ') bytes, $(grep -c '^COPY ' "$DUMP_FILE") COPY blocks"

# Patch search_path (trigger functions need to resolve public.* unqualified)
sed -i.bak "s|set_config('search_path', '', false)|set_config('search_path', 'public, pg_catalog', false)|" "$DUMP_FILE"

# Restore
echo ""
echo "-- 4. restore (BEGIN + SET CONSTRAINTS DEFERRED + COMMIT) --"
WRAPPED=/tmp/butterbase-phase2-use1-wrapped.sql
{
  echo "BEGIN;"
  echo "SET CONSTRAINTS ALL DEFERRED;"
  cat "$DUMP_FILE"
  echo "COMMIT;"
} > "$WRAPPED"
time "$PSQL" "$RUNTIME_USE1_URL" -v ON_ERROR_STOP=1 -f "$WRAPPED" 2>&1 | tail -5

# Backfill apps.region (defensive)
"$PSQL" "$RUNTIME_USE1_URL" -v ON_ERROR_STOP=1 -c "UPDATE apps SET region='us-east-1' WHERE region IS NULL" 2>&1 | tail -3

# Reset sequences
echo ""
echo "-- 5. reset sequences --"
"$PSQL" "$RUNTIME_USE1_URL" -v ON_ERROR_STOP=1 -c "
SET search_path TO public;
DO \$\$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
    FROM pg_class s
    JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
    JOIN pg_class t ON t.oid = d.refobjid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
    WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace
      AND t.relname != '_runtime_migrations'
  LOOP
    BEGIN
      EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM public.%I), 1), true)', r.seq, r.col, r.tbl);
    EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END\$\$;
" 2>&1 | tail -3

# Verify
echo ""
echo "-- 6. row count parity --"
DEST_COUNT_SQL=$(for t in "${TABLES[@]}"; do echo "SELECT '$t' AS t, count(*) FROM $t UNION ALL"; done | sed '$ s/UNION ALL$//')
"$PSQL" "$RUNTIME_USE1_URL" -t -A -F'|' -c "$DEST_COUNT_SQL ORDER BY 1" 2>&1 > /tmp/dest-counts.txt

PASS=0; FAIL=0
while IFS='|' read -r t src; do
  dst=$(grep "^${t}|" /tmp/dest-counts.txt | cut -d'|' -f2)
  if [ "$src" = "$dst" ]; then
    PASS=$((PASS+1))
  else
    echo "  DIFF: $t  src=$src  dst=$dst"
    FAIL=$((FAIL+1))
  fi
done < /tmp/source-counts.txt
echo "  $PASS/${#TABLES[@]} tables match, $FAIL diff"

echo ""
echo "=== Phase 2 dump+restore complete ==="
