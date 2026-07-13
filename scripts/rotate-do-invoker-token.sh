#!/usr/bin/env bash
#
# Rotate DO_INVOKER_TOKEN across the three places that must agree:
#
#   1. Cloudflare Worker `do-invoker` (wrangler secret)
#   2. Fly app `butterbase-platform` (control-api reads it into config.doInvoker,
#      injected into every user DO Worker's env bundle on next bundleAndDeploy)
#   3. Fly app `butterbase-runtime` (deno-runtime reads it into the fn ctx source
#      inlined for ctx.invokeDO's Authorization header)
#
# Any drift between these three values breaks ctx.invokeDO with a 401 at the
# do-invoker shim.
#
# Usage:
#   scripts/rotate-do-invoker-token.sh
#
# Env (required):
#   CLOUDFLARE_ACCOUNT_ID    — the CF account do-invoker lives on
#
# Env (optional):
#   FLY_PLATFORM_APP=butterbase-platform
#   FLY_RUNTIME_APP=butterbase-runtime
#   WORKER_NAME=do-invoker
#   DRY_RUN=1                — print what would happen, don't touch anything
#
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
FLY_PLATFORM_APP="${FLY_PLATFORM_APP:-butterbase-platform}"
FLY_RUNTIME_APP="${FLY_RUNTIME_APP:-butterbase-runtime}"
WORKER_NAME="${WORKER_NAME:-do-invoker}"

log() { printf '%s\n' "$*" >&2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Sanity-check the CLIs before we start rotating anything.
command -v wrangler >/dev/null || die "wrangler CLI not found on PATH"
command -v fly >/dev/null || die "fly CLI not found on PATH"
command -v openssl >/dev/null || die "openssl not found on PATH"
command -v curl >/dev/null || die "curl not found on PATH"

# 1. Mint a fresh token. 32 bytes / 64 hex chars.
NEW_TOKEN="$(openssl rand -hex 32)"
if [ "${#NEW_TOKEN}" -ne 64 ]; then
  die "openssl rand did not produce a 64-char token"
fi
log "==> minted new token (64 hex chars, first 8 = ${NEW_TOKEN:0:8}…)"

if [ "${DRY_RUN:-}" = "1" ]; then
  log "DRY_RUN=1 — would now set on:"
  log "  - CF Worker $WORKER_NAME (account $CLOUDFLARE_ACCOUNT_ID)"
  log "  - Fly app $FLY_PLATFORM_APP"
  log "  - Fly app $FLY_RUNTIME_APP"
  exit 0
fi

# 2. Set on the CF Worker first. If this fails the platform is unchanged.
log "==> setting DO_INVOKER_TOKEN on CF Worker $WORKER_NAME"
printf '%s' "$NEW_TOKEN" | CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" wrangler secret put DO_INVOKER_TOKEN --name "$WORKER_NAME" >&2 \
  || die "wrangler secret put failed"

# 3. Discover the Worker URL — needed for the verify step. wrangler doesn't
# expose it cleanly, so grep it out of `wrangler deployments list` output.
WORKER_URL="$(wrangler deployments list --name "$WORKER_NAME" 2>&1 | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)"
if [ -z "$WORKER_URL" ]; then
  # Fallback: try the common shape. Caller can also set WORKER_URL explicitly.
  WORKER_URL="${WORKER_URL_OVERRIDE:-https://${WORKER_NAME}.workers.dev}"
  warn "could not auto-detect worker URL; falling back to $WORKER_URL. Set WORKER_URL_OVERRIDE if this is wrong."
fi

# 4. Stage on both Fly apps. --stage means the machine is NOT restarted yet;
# a subsequent `fly deploy` or `fly machine restart` picks it up.
for APP in "$FLY_PLATFORM_APP" "$FLY_RUNTIME_APP"; do
  log "==> staging DO_INVOKER_TOKEN on Fly app $APP"
  fly secrets set --stage --app "$APP" DO_INVOKER_TOKEN="$NEW_TOKEN" >&2 \
    || die "fly secrets set --stage failed on $APP"
done

# 5. Restart the machines so the new token is actually live in-process.
# Using restart rather than deploy so we don't rebuild the image.
for APP in "$FLY_PLATFORM_APP" "$FLY_RUNTIME_APP"; do
  log "==> restarting machines on $APP so the staged secret takes effect"
  fly machine restart --app "$APP" >&2 \
    || die "fly machine restart failed on $APP — token is staged but not live; manual rollback needed"
done

# 6. Verify: hit /invoke with the new bearer. Expect 400 (missing routing
# headers), NOT 401 (which would mean the CF secret didn't propagate).
log "==> verifying new token against $WORKER_URL/invoke"
sleep 3  # small buffer for CF secret propagation.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "authorization: Bearer $NEW_TOKEN" "$WORKER_URL/invoke")"
if [ "$STATUS" = "400" ]; then
  log "✓ verified: 400 (missing routing headers) — new token accepted"
elif [ "$STATUS" = "401" ]; then
  die "verification 401 — CF secret did not propagate. Fly is now on the NEW token but CF is still on the OLD one. Re-run wrangler secret put manually and re-verify."
else
  warn "verification returned $STATUS (expected 400) — investigate before considering rotation complete"
fi

log ""
log "rotation complete."
log "next: audit-log the rotation, and confirm ctx.invokeDO in a test fn still works."
