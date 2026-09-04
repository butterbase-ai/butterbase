# Known limitations & follow-ups

Things that are deliberately deferred. Update when the underlying platform constraint lifts.

## Meetings live in substrate; the realtime client doesn't subscribe to substrate yet

**Symptom**: Changes to a meeting (title, time, attendees, notetaker status) made in one tab don't push to other open tabs of the same workspace. Reads fall back to React Query staleTime / window-focus refetch.

**Why deferred**: The CRM's `realtime.ts` subscribes to Postgres CDC for the remaining CRM tables (`companies`, `people`, `deals`, `notes`, `activities`, `attachments`). Substrate has its own websocket stream at `wss://api.butterbase.ai/v1/me/substrate/stream`, but it requires a one-shot ticket exchanged via `POST /v1/me/substrate/ws-ticket`, which `substrate-proxy` doesn't expose yet. We took the minimum-viable path and removed `meetings` from the CDC subscription rather than implement both flows in one commit.

**To finish**:
1. Add a `ws_ticket` op to `backend/functions/substrate-proxy/handler.ts` that calls `ctx.substrate.http.post('/ws-ticket')` (or `/v1/me/substrate/ws-ticket` via the rawGet pattern).
2. In `frontend/src/lib/realtime.ts`, add a parallel WS loop that mirrors the CDC reconnect/backoff behavior.
3. On a server frame `{tbl: 'entities', op: 'insert'|'update'|'delete'}`, invalidate React Query keys: `qk.meetings(workspaceId)`, `['meetings', workspaceId, 'byEntity']`, `['meeting_substrate_attendees']`, and the companies/people keys (those also read from substrate now).

## Meeting notetaker — one-time webhook registration required per clone

**Symptom**: After cloning the app, the "Send notetaker" button dispatches a bot, but the transcript never lands and `attrs.notetaker_status` stays at `pending_transcript`. Logs on `notetaker-webhook` show `webhook_not_configured` or 401 `invalid_signature`.

**Why**: `start-meeting-bot` dispatches via Butterbase's `/v1/{app_id}/ai/meetings` primitive. The platform POSTs lifecycle events (`transcript.done`, `bot.fatal`, etc.) back to a single per-app forward URL that has to be registered once, returning an HMAC signing secret. `notetaker-webhook` ships with an empty `NOTETAKER_WEBHOOK_SECRET` envVar — until that's filled, every signed callback is rejected.

**To finish (one-time admin step)**:

```bash
curl -X PUT https://api.butterbase.ai/v1/app_44zjayftl7b3/ai/meetings/webhook \
  -H "authorization: Bearer $BUTTERBASE_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "forward_url": "https://api.butterbase.ai/v1/app_44zjayftl7b3/fn/notetaker-webhook",
    "rotate_secret": true
  }'
# → { "secret": "wsec_..." }   ← copy this once
```

Then set the secret on the function (replace `wsec_...`):

```bash
# Via MCP: manage_function action=update_env, function_name=notetaker-webhook,
#         env={"NOTETAKER_WEBHOOK_SECRET": "wsec_..."}
# Or via dashboard env editor on notetaker-webhook.
```

The previous OSS-bot / Cloudflare Containers framing here is **obsolete** — Butterbase shipped first-class hosted meeting bots (Zoom/Meet/Teams/Webex) billed against the app's AI credits pool, replacing the need to self-host. See [Butterbase docs › AI Meetings](https://docs.butterbase.ai/ai-meetings).

## Substrate `/entities` has a hard server-side cap at 200 results

**Symptom**: `substrate-proxy` `list_entities` with `limit > 200` returns 502 `substrate_op_failed` (upstream `substrate.findEntities failed: 500`). Confirmed by bisect on 2026-06-11: `limit=200` returns 99 entities, `limit=201` and above all 502. The platform-side MCP `find_entities` tool advertises a stricter cap of 100, but the underlying `/entities` endpoint accepts up to 200.

**Why we can't fix client-side**: The cap is enforced by substrate's `/entities` endpoint, not by our proxy. Bumping `clampLimit` past 200 just produces 5xx responses. All callsites (proxy, `crm-upsert-meeting`, `useMeetings`, `useCompanies`, `usePeople`, `useCustomFields`, `lib/substrate`, `MeetingAIDialog`, `PersonDialog`, `PersonDetail`, `migrate-meetings-to-substrate`, `propose-deals`, `agent-chat`) are pinned to `limit: 200`.

**Implication for scale**: Workspaces with >200 entities of a single type (events, persons, companies) silently truncate. We're currently at 99 meetings — roughly half the cap. Real fix needs paginated reads on `substrate-proxy` (loop calls with a `before` cursor) so callers can iterate beyond 200. Watch for truncation symptoms (missing companies/people/meetings in the CRM after sync) as the data grows.

## Submit suggestion to Butterbase

When raising platform asks with `mcp__butterbase__submit_suggestion`: the headline ask is **first-class Cloudflare Containers** with a Durable Object front-door pattern, billed per app. It unlocks headless browser scraping, PDF/audio transcoding, self-hosted Whisper / local LLMs, sandboxed code execution — an entire class of features that today require a third-party SaaS + API key. (Meeting bots, previously the marquee use-case, are no longer pending — Butterbase ships `/v1/{app_id}/ai/meetings` natively.)
