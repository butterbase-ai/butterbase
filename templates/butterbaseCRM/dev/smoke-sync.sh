#!/usr/bin/env bash
# End-to-end verification of CRM ↔ substrate sync.
#
# Exercises:
#   1. CRM-create via crm-upsert-company (source=ui) → outbox enqueued
#   2. Re-upsert same payload → no second outbox row (no-op guard)
#   3. Wait for drain-substrate-outbox cron → company gets a substrate_entity_id
#   4. Echo guard: re-upsert with source=substrate and the substrate_entity_id
#      → no new outbox row enqueued
#   5. crm-record-activity twice with same dedupe_key → second is a no-op
#
# Required env:
#   BUTTERBASE_API_URL  (e.g. https://api.butterbase.ai/v1/app_44zjayftl7b3)
#   USER_JWT            (an end-user JWT for the workspace)
#   WORKSPACE_ID        (the target workspace uuid)
#
# Optional:
#   DRAIN_TIMEOUT_SEC   (default 120) — how long to wait for substrate push
#
# Usage:
#   USER_JWT=... WORKSPACE_ID=... BUTTERBASE_API_URL=... ./dev/smoke-sync.sh

set -euo pipefail

: "${BUTTERBASE_API_URL:?BUTTERBASE_API_URL is required}"
: "${USER_JWT:?USER_JWT is required}"
: "${WORKSPACE_ID:?WORKSPACE_ID is required}"
DRAIN_TIMEOUT_SEC="${DRAIN_TIMEOUT_SEC:-120}"

API="$BUTTERBASE_API_URL/fn"
# Table reads use $BUTTERBASE_API_URL/<table>?col=op.value (PostgREST-ish via SDK path).
DATA="$BUTTERBASE_API_URL"
CURL=(curl -sS --http1.1 -H "authorization: Bearer $USER_JWT" -H "content-type: application/json")
GET=(curl -sS --http1.1 -H "authorization: Bearer $USER_JWT")

stamp=$(date +%s)
domain="smoke-$stamp.example.com"
person_email="smoke-person-$stamp@$domain"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }

# A reusable assertion helper (jq-equality + bail on mismatch).
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" != "$expected" ]; then
    red "✗ $label: expected '$expected' got '$actual'"
    exit 1
  else
    green "  ✓ $label"
  fi
}

echo "→ 1. Create a fresh company via crm-upsert-company (source=ui)"
co=$("${CURL[@]}" -X POST "$API/crm-upsert-company" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"source\":\"ui\",\"attrs\":{\"name\":\"Smoke $stamp\",\"domain\":\"$domain\"}}")
echo "   $co"
company_id=$(echo "$co" | jq -r '.id')
assert_eq "$(echo "$co" | jq -r '.created')"  "true"  "created=true"
assert_eq "$(echo "$co" | jq -r '.enqueued')" "true"  "enqueued=true"

echo "→ 2. Re-upsert with the exact same payload — no-op guard must hold"
co2=$("${CURL[@]}" -X POST "$API/crm-upsert-company" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"source\":\"ui\",\"attrs\":{\"name\":\"Smoke $stamp\",\"domain\":\"$domain\"}}")
echo "   $co2"
assert_eq "$(echo "$co2" | jq -r '.id')"      "$company_id" "same company id"
assert_eq "$(echo "$co2" | jq -r '.created')" "false"        "created=false"

# Count outbox rows for this company — must be exactly 1.
outbox_count=$("${GET[@]}" "$DATA/substrate_outbox?entity_id=eq.$company_id&select=id" | jq 'length')
assert_eq "$outbox_count" "1" "exactly 1 outbox row after no-op re-upsert"

echo "→ 3. Wait up to ${DRAIN_TIMEOUT_SEC}s for drain-substrate-outbox to push"
sid=""
deadline=$(( $(date +%s) + DRAIN_TIMEOUT_SEC ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 5
  row=$("${GET[@]}" "$DATA/companies?id=eq.$company_id&select=substrate_entity_id" || true)
  sid=$(echo "$row" | jq -r '.[0].substrate_entity_id // empty')
  if [ -n "$sid" ] && [ "$sid" != "null" ]; then
    green "  ✓ pushed: substrate_entity_id=$sid"
    break
  fi
done
if [ -z "$sid" ] || [ "$sid" = "null" ]; then
  red "✗ drainer did not push within ${DRAIN_TIMEOUT_SEC}s"
  exit 1
fi

echo "→ 4. Echo guard: re-upsert with source=substrate and the substrate_entity_id"
co3=$("${CURL[@]}" -X POST "$API/crm-upsert-company" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"source\":\"substrate\",\"substrate_entity_id\":\"$sid\",\"attrs\":{\"name\":\"Smoke $stamp (substrate)\",\"domain\":\"$domain\"}}")
echo "   $co3"
assert_eq "$(echo "$co3" | jq -r '.id')"       "$company_id" "echo guard reused same crm id"
assert_eq "$(echo "$co3" | jq -r '.enqueued')" "false"       "enqueued=false on substrate source"

echo "→ 5. Create a person to attach activities to"
pe=$("${CURL[@]}" -X POST "$API/crm-upsert-person" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"source\":\"ui\",\"attrs\":{\"first_name\":\"Smoke\",\"last_name\":\"$stamp\",\"email\":\"$person_email\",\"company_id\":\"$company_id\"}}")
echo "   $pe"
person_id=$(echo "$pe" | jq -r '.id')
assert_eq "$(echo "$pe" | jq -r '.created')" "true" "person created"

echo "→ 6. Record activity twice with same dedupe_key — second must be a no-op"
a1=$("${CURL[@]}" -X POST "$API/crm-record-activity" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"kind\":\"email.received\",\"entity_type\":\"person\",\"entity_id\":\"$person_id\",\"dedupe_key\":\"smoke-msg-$stamp\",\"payload\":{\"subject\":\"hi $stamp\"}}")
a2=$("${CURL[@]}" -X POST "$API/crm-record-activity" \
  -d "{\"workspace_id\":\"$WORKSPACE_ID\",\"kind\":\"email.received\",\"entity_type\":\"person\",\"entity_id\":\"$person_id\",\"dedupe_key\":\"smoke-msg-$stamp\",\"payload\":{\"subject\":\"hi $stamp\"}}")
assert_eq "$(echo "$a1" | jq -r '.id')"      "$(echo "$a2" | jq -r '.id')" "same activity id"
assert_eq "$(echo "$a2" | jq -r '.created')" "false"                        "second activity create=false"

echo
green "✓ Smoke complete — all 6 phases passed."
