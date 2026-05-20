#!/usr/bin/env bash
# Dry-run cutover: dump the 27 runtime-tier tables from prod read-only branch
# into runtime-use1. Schemas already exist on use1 (Stage 3c bootstrapped them).
# Restore wraps everything in session_replication_role=replica so FKs are
# deferred during load and re-validated on COMMIT.
#
# Required env vars:
#   PROD_READONLY_URL  - read-only Neon branch of prod control DB
#   RUNTIME_USE1_URL   - new runtime DB in us-east-1
#
# Idempotent: safe to re-run. Asserts use1 tables are empty before loading.

set -euo pipefail

: "${PROD_READONLY_URL:?Missing PROD_READONLY_URL}"
: "${RUNTIME_USE1_URL:?Missing RUNTIME_USE1_URL}"

PG_DUMP=/opt/homebrew/opt/libpq/bin/pg_dump
PSQL=/opt/homebrew/opt/libpq/bin/psql
DUMP_FILE=/tmp/butterbase-dry-run-use1.sql

# 27 tables: MOVE_APP_RUNTIME_TABLES + apps
TABLES=(
  apps
  app_users app_refresh_tokens app_verification_codes app_signing_keys
  app_oauth_configs app_connected_accounts
  app_custom_domains
  app_functions function_triggers function_invocations
  app_edge_ssr_deployments app_durable_objects app_do_deploy_state
  app_do_env_vars app_frontend_env_vars
  app_realtime_config app_integration_configs oauth_states
  storage_objects
  app_orders app_plans app_products app_subscriptions
  audit_events ai_usage_logs mcp_tool_call_log
)

echo "=== Dry run: prod RO → runtime-use1 ==="
echo "Tables: ${#TABLES[@]}"

# Safety: confirm use1 tables are empty before loading
echo ""
echo "-- Pre-flight: confirm use1 tables empty --"
EMPTY_CHECK=$("$PSQL" "$RUNTIME_USE1_URL" -t -A -c "
  SELECT COALESCE(SUM(n),0)::int FROM (
    $(for t in "${TABLES[@]}"; do echo "  SELECT count(*) AS n FROM $t UNION ALL"; done | sed '$ s/UNION ALL$//')
  ) s
" 2>&1)
echo "  use1 total rows across 27 tables: $EMPTY_CHECK"
if [ "$EMPTY_CHECK" != "0" ]; then
  echo "  ABORT: use1 not empty (got $EMPTY_CHECK rows). Truncate first or investigate."
  exit 1
fi

# Build pg_dump table flags
DUMP_ARGS=()
for t in "${TABLES[@]}"; do
  DUMP_ARGS+=(-t "public.$t")
done

echo ""
echo "-- Step 1/4: pg_dump from prod RO --"
time "$PG_DUMP" "$PROD_READONLY_URL" \
  --data-only --no-owner --no-privileges \
  "${DUMP_ARGS[@]}" \
  --file="$DUMP_FILE"
echo "  wrote $(wc -c < "$DUMP_FILE" | tr -d ' ') bytes to $DUMP_FILE"
echo "  COPY statements:"
grep -c "^COPY " "$DUMP_FILE" | awk '{print "  -",$0,"COPY blocks"}'

# Wrap restore in a single transaction with deferred constraints. Neon's
# neondb_owner can't SET session_replication_role (needs superuser), but
# SET CONSTRAINTS ALL DEFERRED works for any DEFERRABLE FK; pg_dump's
# --data-only already orders tables topologically so most non-deferrable FKs
# resolve naturally too.
WRAPPED=/tmp/butterbase-dry-run-use1.wrapped.sql
{
  echo "BEGIN;"
  echo "SET CONSTRAINTS ALL DEFERRED;"
  cat "$DUMP_FILE"
  echo "COMMIT;"
} > "$WRAPPED"

echo ""
echo "-- Step 2/4: psql restore into use1 --"
time "$PSQL" "$RUNTIME_USE1_URL" -v ON_ERROR_STOP=1 -f "$WRAPPED" 2>&1 | tail -20

echo ""
echo "-- Step 3/4: reset sequences --"
"$PSQL" "$RUNTIME_USE1_URL" -v ON_ERROR_STOP=1 -c "
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
  LOOP
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 1), true)', r.seq, r.col, r.tbl);
    RAISE NOTICE '  reset % to MAX(%.%)', r.seq, r.tbl, r.col;
  END LOOP;
END\$\$;
" 2>&1 | tail -40

echo ""
echo "-- Step 4/4: verify row counts match between prod RO and use1 --"
for t in "${TABLES[@]}"; do
  PROD_N=$("$PSQL" "$PROD_READONLY_URL" -t -A -c "SELECT count(*) FROM $t" 2>/dev/null || echo "ERR")
  USE1_N=$("$PSQL" "$RUNTIME_USE1_URL" -t -A -c "SELECT count(*) FROM $t WHERE archived_after_move IS NULL OR archived_after_move IS NOT NULL" 2>/dev/null || echo "ERR")
  if [ "$PROD_N" = "$USE1_N" ]; then
    STATUS="OK"
  else
    STATUS="DIFF"
  fi
  printf "  %-30s  prod=%-7s  use1=%-7s  %s\n" "$t" "$PROD_N" "$USE1_N" "$STATUS"
done

echo ""
echo "=== Dry run complete ==="
