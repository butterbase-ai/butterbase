#!/usr/bin/env bash
# Pre-seed standby control DB from prod using CREATE_REPLICATION_SLOT EXPORT_SNAPSHOT.
#
# Mechanism:
#   1. Background psql session opens replication connection, runs
#      CREATE_REPLICATION_SLOT ... EXPORT_SNAPSHOT, then `\! sleep 600`
#      to hold the snapshot alive while pg_dump runs.
#   2. We parse the slot_name + consistent_point + snapshot_name from
#      the psql output.
#   3. pg_dump --snapshot=<exported> writes a consistent dump at the
#      slot's LSN — no concurrent writes can advance past it.
#   4. psql restores onto standby (standby was truncated, schema in place).
#   5. We kill the psql session (snapshot released, slot remains).
#   6. CREATE SUBSCRIPTION on standby with create_slot=false,
#      slot_name=platform_dr_sub, copy_data=false — apply worker
#      starts streaming from the slot's LSN. No initial COPY load
#      because data is already pre-seeded.
set -euo pipefail

: "${PROD_DIRECT_URL:?Missing PROD_DIRECT_URL (non-pooler, replication-capable)}"
: "${PROD_POOL_URL:?Missing PROD_POOL_URL}"
: "${STANDBY_URL:?Missing STANDBY_URL}"

PSQL=/opt/homebrew/opt/libpq/bin/psql
PG_DUMP=/opt/homebrew/opt/libpq/bin/pg_dump
DUMP=/tmp/butterbase-control-preseed.sql
SLOT_OUT=/tmp/butterbase-slot-info.txt
PROD_REPL="${PROD_DIRECT_URL}&replication=database"

echo "=== Pre-seeding standby control DB ==="

# Drop any leftover slot from prior attempts
"$PSQL" "$PROD_POOL_URL" -c "
DO \$\$
BEGIN
  PERFORM pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name='platform_dr_sub';
EXCEPTION WHEN OTHERS THEN NULL; END\$\$;
" >/dev/null 2>&1 || true

echo ""
echo "-- 1. background psql: CREATE_REPLICATION_SLOT ... EXPORT_SNAPSHOT, hold open --"
rm -f "$SLOT_OUT"
("$PSQL" "$PROD_REPL" --no-psqlrc -X <<'EOSQL' > "$SLOT_OUT" 2>&1
CREATE_REPLICATION_SLOT platform_dr_sub LOGICAL pgoutput EXPORT_SNAPSHOT;
\! sleep 600
EOSQL
) &
PSQL_PID=$!
echo "  background psql pid=$PSQL_PID"

# Wait for the slot output to appear (snapshot name pattern is hex-hex-int)
echo "  waiting for slot create..."
for _ in $(seq 1 30); do
  if grep -qE "[0-9A-F]+-[0-9A-F]+-[0-9]+" "$SLOT_OUT" 2>/dev/null; then break; fi
  sleep 0.5
done

if ! grep -qE "[0-9A-F]+-[0-9A-F]+-[0-9]+" "$SLOT_OUT" 2>/dev/null; then
  echo "ABORT: did not see slot output. Content:"
  cat "$SLOT_OUT"
  kill "$PSQL_PID" 2>/dev/null || true
  exit 1
fi

cat "$SLOT_OUT"

# Parse snapshot name (hex-hex-int) and consistent_point (lsn)
SNAPSHOT=$(grep -oE "[0-9A-F]{8}-[0-9A-F]{8}-[0-9]+" "$SLOT_OUT" | head -1)
CONSISTENT=$(grep -oE "[0-9A-F]+/[0-9A-F]+" "$SLOT_OUT" | head -1)
echo ""
echo "  slot_name=platform_dr_sub  snapshot=$SNAPSHOT  consistent_point=$CONSISTENT"

if [ -z "$SNAPSHOT" ]; then
  echo "ABORT: could not parse snapshot name"
  kill "$PSQL_PID" 2>/dev/null || true
  exit 1
fi

echo ""
echo "-- 2. pg_dump with --snapshot (using slot's exported snapshot) --"
time "$PG_DUMP" "$PROD_POOL_URL" \
  --snapshot="$SNAPSHOT" \
  --data-only --no-owner --no-privileges \
  -N _runtime_migrations \
  -f "$DUMP"
echo "  dump: $(wc -c < "$DUMP" | tr -d ' ') bytes, $(grep -c '^COPY ' "$DUMP") COPY blocks"

echo ""
echo "-- 3. release snapshot (slot remains) --"
kill "$PSQL_PID" 2>/dev/null || true
wait "$PSQL_PID" 2>/dev/null || true

# Confirm slot still exists on prod
"$PSQL" "$PROD_POOL_URL" -c "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name='platform_dr_sub'"

echo ""
echo "-- 4. restore to standby (in transaction, deferred constraints) --"
WRAPPED=/tmp/butterbase-control-preseed-wrapped.sql
{
  echo "BEGIN;"
  echo "SET CONSTRAINTS ALL DEFERRED;"
  cat "$DUMP"
  echo "COMMIT;"
} > "$WRAPPED"

time "$PSQL" "$STANDBY_URL" -v ON_ERROR_STOP=1 -f "$WRAPPED" 2>&1 | tail -5

echo ""
echo "-- 5. reset sequences on standby --"
"$PSQL" "$STANDBY_URL" -v ON_ERROR_STOP=1 -c "
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
      AND t.relname NOT LIKE '_runtime_migrations%'
  LOOP
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM public.%I), 1), true)', r.seq, r.col, r.tbl);
  END LOOP;
END\$\$;
" 2>&1 | tail -3

echo ""
echo "-- 6. CREATE SUBSCRIPTION on standby (slot pre-exists; no COPY) --"
"$PSQL" "$STANDBY_URL" -v ON_ERROR_STOP=1 -X <<EOF 2>&1 | tail -5
CREATE SUBSCRIPTION platform_dr_sub
  CONNECTION '${PROD_DIRECT_URL}&channel_binding=require'
  PUBLICATION platform_dr
  WITH (copy_data = false, create_slot = false, slot_name = 'platform_dr_sub', enabled = true);
EOF

echo ""
echo "-- 7. wait 8s, verify apply worker --"
sleep 8
"$PSQL" "$STANDBY_URL" -x -c "SELECT subname, pid, received_lsn, last_msg_receipt_time FROM pg_stat_subscription WHERE subname='platform_dr_sub'"

echo ""
echo "-- 8. prod slot active? --"
"$PSQL" "$PROD_POOL_URL" -c "SELECT slot_name, active, active_pid, restart_lsn, confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name='platform_dr_sub'"

echo ""
echo "=== Pre-seed complete ==="
