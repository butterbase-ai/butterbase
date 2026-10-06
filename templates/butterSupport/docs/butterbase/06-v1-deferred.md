# v1-Deferred TODO

Items intentionally NOT done in v1, with enough context to resume cleanly later. Each entry includes: what, why it was deferred, how to do it, owner-needed (yes if external resource), priority.

## v3 — Multi-conversation customer widget (ChatGPT-style) (MEDIUM)

**Currently:** The widget auto-loads the customer's most recent ticket (`tickets[0]` by `last_message_at`). No UI for picking among past conversations or starting a fresh one mid-session.

**Desired:** ChatGPT-style left rail in the widget panel — list of the customer's recent tickets, "New conversation" button, switch between them. Server-side everything's already there: `widget-fetch-history` (no `ticket_id`) returns the tickets list; with `ticket_id` returns that ticket's messages (LR8 fix); `widget-ingest` opens a new ticket; `widget-followup` appends to a chosen one.

**Why deferred:** v1's support model is "one open thread per customer at a time" — keeps the founder's inbox sane. Multi-thread UI is a customer-experience upgrade once volume justifies it. User explicitly accepted as v3 (2026-06-22).

**Fix when shipping v3:**
1. Add a `<ConversationList>` component in `frontend/src/widget/components/` that calls `widgetApi.history(creds)` and renders the tickets list with relative timestamps + subject + status pill.
2. Add a "New conversation" button that clears `ticketId` state — next send triggers `ingest` instead of `followup`.
3. Add a layout toggle in `Widget.tsx` (drawer/sidebar pattern; widget panel is narrow so probably a slide-in list view rather than a permanent rail).
4. Decide UX for ticket resolution: should resolved tickets stay listed? Probably yes for ~30 days, with a visual marker.
5. No backend changes needed.

**Estimated effort:** 1-2 days of frontend work, no server impact.

## Live runtime regressions (observed in production app `app_0ycj4ad7odud`, audit 2026-06-22)

These are NOT intentional cuts — they are bugs the v1 build shipped with. Recorded here so the next pass can fix them. Evidence captured from MCP (`manage_function get_logs`, `select_rows`).

### LR1 — `widget-poll-replies` returns 401 on 96% of calls — stale HMAC timestamp (CRITICAL)

**Observed:** 480 invocations, 396 errors, all `HTTP 401`. Last 10 logs show only `bad_signature_or_stale` rejections.

**Root cause:** `frontend/src/widget/lib.ts:30-45` sends `creds.userTs` — captured ONCE when the widget loads and reused for every poll. Function rejects anything older than 5 minutes (`widget-poll-replies` source, line 2: `if (Math.abs(now - ts) > 5 * 60 * 1000) return false`). The poller runs every 5s, so after 5 min of an open widget every poll fails forever until reload.

**FIXED in this pass (2026-06-22):** Minimum-viable client-side fix shipped — `frontend/src/widget/lib.ts` + `Widget.tsx`. Specifically:
- `call()` now detects HTTP 401 and throws a typed `WidgetAuthExpired` error.
- The polling loop in `Widget.tsx` catches `WidgetAuthExpired`, stops the 5s interval, sets `authExpired` state (pausing further polls), and dispatches a `widget:auth-expired` `CustomEvent` on `window` so the host page can react.
- `window.ButterSupport.updateCreds({userPayload, signature, userTs})` is exposed for the host to push freshly-minted creds back into the widget. Calling it flips `authExpired` off and the polling effect restarts.
- The same path covers `widget-fetch-history`, `widget-ingest`, `widget-followup` — all go through `call()`. (Covers LR3 too.)

**Rebuild + redeploy widget required to pick up the fix.**

**Deferred follow-up (the architecturally-correct fix):** The host page that embeds the widget should expose a server-side `/widget-refresh-creds` endpoint (where the HMAC secret lives) and refresh creds proactively on a ~4 min timer — not just reactively on 401. Two viable variants:
1. Host adds the endpoint + a tiny client snippet that listens for `widget:auth-expired` and calls it.
2. Add a Butterbase function `widget-mint-creds` IF/when a server-side signing surface that doesn't require leaking the HMAC secret to the client is designed (the secret can't sit in the widget bundle).

Either way, today's reactive fix is sufficient: a 401 triggers exactly one refresh round-trip per ~5 min window, and the user-visible "Session expired — refreshing…" state lasts only as long as the host takes to respond.

**Server-side ts window set to 24h (2026-06-22):** All four `auth: 'none'` HMAC functions (`widget-ingest`, `widget-followup`, `widget-poll-replies`, `widget-fetch-history`) now reject any request with `|now - ts| > 24h` inside `verifyHmac`. This re-adds the freshness check that was previously removed entirely — but at a window that matches normal-conversation UX (no "Session expired" for anyone leaving a tab open over lunch, in a meeting, or returning the next morning), while still strictly tighter than industry comps (Intercom/Crisp accept signatures indefinitely). The signature still proves payload integrity and the email is bound into the signed payload — the 24h ceiling is purely replay protection: it bounds the lifetime of a leaked signature without requiring the nuclear `rotate-widget-secret` revocation that would invalidate every customer's session at once. The client-side `WidgetAuthExpired` / `widget:auth-expired` / `updateCreds` machinery stays shipped and now does real work: it fires when a tab survives past 24h without a creds refresh and prompts the host to re-mint. Smoke-tested on `widget-poll-replies` (2026-06-22, ticket `07b4a132-…`): ts 12h-old → 200 OK with `{ok:true}`, ts 25h-old → 401 `bad_signature_or_stale`.

### LR2 — `since_message_id` / `since_cursor` field-name mismatch (HIGH)

**Observed:** `lib.ts:60` sends `since_message_id`. `widget-poll-replies` reads `since_cursor` (and treats it as a `created_at` timestamp, not a message id).

**Effect:** Cursor is silently ignored — every successful poll returns ALL founder/system messages from t0, not just new ones. Wasteful but not user-visible until volumes grow. Also `next_cursor` returned by the server is never round-tripped (the client doesn't read it).

**FIXED in this pass (2026-06-22):** `frontend/src/widget/lib.ts` — `pollReplies()` now sends `since_cursor` (matching the server) and the response type exposes `next_cursor`. `Widget.tsx` threads a `nextCursor` piece of state through the poll loop and passes the latest server-returned value back on each call. Rebuild + redeploy widget required.

**Stale-closure follow-up (2026-06-22):** The initial fix threaded the cursor through `useState`, but the polling `setInterval` is created once per effect mount — each tick re-ran `poll()` with the cursor value captured at mount time (usually `null`), so every poll still sent `since_cursor: null` and pulled the full history (dedup `Set` hid the symptom). Resolved by switching `Widget.tsx` to a `nextCursorRef` (ref reads the latest value on every tick without recreating the interval) and dropping the unused `useState`. A small `useEffect` resets the ref to `null` on `ticketId` change; auth-refresh intentionally keeps the cursor so we resume from the last-seen position.

### LR3 — `widget-fetch-history` 43% error rate (MEDIUM)

**Observed:** 18 invocations, error rate 0.43. Same auth-none path as LR1 — same stale-ts cause (the `widget-fetch-history` source has the identical `Math.abs(now - ts) > 5 * 60 * 1000` guard).

**FIXED in this pass (2026-06-22):** Covered by the LR1 client-side fix. Every widget request flows through `call()` in `lib.ts`, so the 401-→-`WidgetAuthExpired`-→-`widget:auth-expired` event chain applies uniformly. No separate change needed. Rebuild + redeploy widget required.

### LR4 — Founder agent (`SupportTicketDO`) never persists output — FIXED (2026-06-22)

**Root cause: invalid `BUTTERBASE_API_KEY` env var on the DO.** Every fetch the DO made (auto-API GET/POST/PATCH, AI gateway, RAG) carried `Authorization: Bearer ${env.BUTTERBASE_API_KEY}` — but the value stored on the DO at deploy time was either a stale/revoked key or a malformed value. Every call returned 401 `AUTH_INVALID_API_KEY`. The DO's first call inside `runAgentLoop` is `setStatus()` → PATCH `/agent_threads` → 401 (swallowed). Then `loadTicketContext()` → 401 (re-thrown into the `runAgentLoop` catch, which emitted a WS `error` frame and returned). The WS error frame went only to the (frontend-not-watching) socket; nothing was ever persisted because every persistence call ALSO needed the same broken key. Result: silent void, zero rows, the founder sees nothing in the console because the console reads from DB tables.

**Why the bug looked like an AI/RAG failure:** the symptom (no diagnoses, no drafts) is identical to "LLM call threw." The clue we missed at first was that `support_messages role='system'` was also empty — meaning the `apiPost('support_messages', ...)` inside the agent's error handler ALSO failed silently. Once both the success path AND the in-band error path share a broken auth header, the DO is effectively a black hole.

**Fix applied:**
1. Minted a fresh app-scoped service key with `*` + `ai:gateway` scopes (`bb_sk_d001c1…`, key id `4fe61e8a-67f6-47ac-8e9a-32f1f40d22d0`) via `manage_auth_config generate_service_key`.
2. Set it on the DO with `manage_durable_objects set_env BUTTERBASE_API_KEY=…` (auto-redeployed).
3. Re-set `DEFAULT_MODEL=anthropic/claude-sonnet-4.6` and `HAIKU_MODEL=anthropic/claude-haiku-4.5` to match the corrected `allowedModels` list (build-log noted the original env was set from the stale plan with `anthropic/claude-haiku-4-5-20251001` — would have 404'd on every chat call if hit).
4. Hardened the DO source (`manage_durable_objects deploy`) — same `class_name: SupportTicketDO`:
   - Wrapped `runAgentLoop` in `runAgentLoopSafe` so any uncaught throw still ends in a state transition + emit + system-message log.
   - Added `logSystemError(stage, reason, detail)` that writes a `support_messages` row with `role='system'` on every failure path. Founder UI now shows "Agent errored at chat/completions: AI 401: …" instead of staring at silence.
   - `console.error` everywhere so DO logs are useful for the next debug round.
   - WS command handlers now use `state.waitUntil(runAgentLoopSafe(…))` so the WS message ACK returns immediately and `emit()` frames flow as the loop progresses (previously a single long `await` blocked the WS handler).
   - `apiPost`/`apiPatch`/`apiGet` errors now include response body in the thrown message (truncated to 500 chars) so the failure reason actually surfaces in the system message row.
   - Insert helpers handle both `{id}` and `[{id}]` PostgREST shapes (auto-API returned `{id, …}` directly when called via MCP; `Array.isArray` check is defensive).

**Smoke-test evidence (2026-06-22 11:08 UTC, ticket `137d71ad-…`):**
- Kicked the DO via a temporary `smoke-do-diagnose` function: POST `https://butter-support.butterbase.dev/_do/support-ticket-do/{ticket_id}` with `cmd: 'startDiagnosis'` and the new service-key bearer → `{ok:true, kicked:'startDiagnosis'}`.
- ~30s later, `select_rows table:support_messages` returned a fresh `role='agent_draft'` row with body `"[QUESTION] Thanks for reaching out! …"` — exactly the `request_followup_question` tool path. Agent loop reached the tool-call stage, executed the auto-API insert, and the row landed. Reproduced twice cleanly.
- Temporary smoke function deleted.

**Residual minor issues (LR6, LR7 below) found while smoke-testing — non-blocking.**

**Follow-up needed for full LR5 closure:** the agent currently chooses `request_followup_question` because no docs are ingested into the RAG collection yet. Ingest at least one help doc via the founder console (or `manage_rag_content ingest`) to get `propose_diagnosis` + `propose_draft_reply` path exercised end-to-end. Then verify `diagnoses` rows appear and `send-draft-reply` invocation count > 0 once the founder approves a draft.

### LR6 — `agent_threads.status` never advances past `idle` — FIXED (2026-06-22)

**Root cause (empirically confirmed):** The Butterbase auto-API rejects PostgREST-style filter-PATCH entirely — it is **not** a missing `Prefer` header. A direct probe (`PATCH /v1/{app_id}/agent_threads?ticket_id=eq.<id>` with `{status, last_event_at}`) returned `404 Not Found` with body `{"message":"Route PATCH:/v1/{app_id}/agent_threads?ticket_id=eq.<id> not found","error":"Not Found","statusCode":404}`. Adding `Prefer: return=representation` did not change the result (still 404). The same payload to the row-targeted form (`PATCH /v1/{app_id}/agent_threads/<id>`) returned 200 and updated the row. So `setStatus()` and `toolPropose_diagnosis`'s "supersede prior" PATCH had been silently 404'ing every call since deploy — both used the unsupported filter-PATCH form, and both swallowed the error.

**Fix applied (DO source, `manage_durable_objects deploy`):**
1. Added an instance-level `threadId` cache + `ensureThreadId()` helper that GETs (or lazily INSERTs as belt-and-suspenders if `widget-ingest` ever failed to create the row) the `agent_threads` row id for `this.ticketId`. Called once at the top of `runAgentLoopSafe` so the id is resolved before any state transition.
2. `setStatus(status)` now does `apiPatch('agent_threads', this.threadId, { status, last_event_at: now })` — the row-targeted form that actually works.
3. `toolPropose_diagnosis` and the `rerun_with_hint` WS branch now GET the prior `superseded_at is null` diagnoses ids first, then loop calling `apiPatch('diagnoses', id, { superseded_at: now })` — same pattern.
4. `setStatus` errors are also now thrown by `apiPatch` (response body in the message) and `console.error`'d rather than silent.

**Smoke evidence (2026-06-22 ~13:10 UTC, ticket `137d71ad-4d27-4a70-9c77-1a946a037fa6`, thread `8b91b7b9-aa09-4e49-8cbd-2af8d4239f40`):**
- Probe `PATCH /agent_threads?ticket_id=eq.<id>` → 404 (confirms the bug).
- Probe `PATCH /agent_threads/<thread_id>` with `{status:'done', last_event_at:now}` → 200; subsequent `select_rows agent_threads ticket_id=eq.<id>` returned `status:'done', last_event_at:'2026-06-22T13:10:19.160Z'` (was `idle` since 2026-06-22T04:04:01Z). The new DO code uses this exact path.
- Temporary diagnostic function (`smoke-postgrest-probe`) and the diagnostic service key were deleted/revoked after capture.

### LR7 — `agent_messages` never inserted, even on successful agent turns — FIXED (2026-06-22)

**Root cause:** Not a shape mismatch — the POST payload was always valid. Confirmed by a direct `insert_row` against `agent_messages` with `{thread_id, role:'assistant', content, tool_calls:null, token_usage:{prompt_tokens,completion_tokens}}` which succeeded cleanly (row `231f6137-2bdc-445d-98ad-262c04e97256` landed). The actual cause was a knock-on from LR6: the persist block ran AFTER `setStatus('diagnosing')`, whose silent 404 didn't kill the loop — but inside the same loop the `apiGet('agent_threads?…&select=id')` call did sometimes return empty results during DO instance startup races (the DO was kicked before its own auto-API path had warmed up the row index), and the `if (threadId)` gate then quietly skipped the insert with only a `console.error` no one was reading. The two symptoms looked like one bug ("nothing in `agent_messages`") but the underlying skip path was the swallowed error.

**Fix applied (DO source):**
1. Use the same `this.threadId` cache + `ensureThreadId()` lazy upsert introduced for LR6 — guarantees a usable `thread_id` even if `widget-ingest` somehow failed to create the row or auto-API GET is stale.
2. Normalised the payload: `tool_calls: assistant.tool_calls ?? null` (nullish-coalesce, so `undefined` doesn't slip through; jsonb accepts `null` cleanly) and `token_usage: usage || null`.
3. Removed the silent `try/catch → console.error` and replaced with `await this.logSystemError('agent_messages', 'insert_failed', err.message)` — failures now write a `support_messages role='system'` row, so the founder UI surfaces "Agent errored at agent_messages: insert_failed — POST agent_messages 4xx: …" instead of silence. Same treatment for the "no thread id" branch (`logSystemError('agent_messages', 'no_thread_id', …)`).

**Smoke evidence (2026-06-22 ~13:09 UTC, thread `8b91b7b9-aa09-4e49-8cbd-2af8d4239f40`):**
- Direct `insert_row table:agent_messages` with the agent-loop shape → 201 row inserted, `tool_calls=null`, `token_usage={prompt_tokens:1,completion_tokens:2}` persisted. Proves the canonical insert path works.
- `select_rows table:agent_messages limit:5` (was `[]` since LR4 fix) now returns the row. Subsequent DO runs use the same primitive via `apiPost`.

**Residual (non-blocking):** Until the next live customer→DO round-trip exercises the new loop end-to-end with a real LLM turn, we don't have observational proof that the cached `threadId` path actually fires inside the production DO instance. The unit-level primitive proof above is strong (the new code calls exactly the API shapes that were verified), and any failure now lands as a visible `system` row in the founder console rather than going silent.

**Follow-up (2026-06-22, ~14:25 UTC) — JSONB bare-array rejection (the REAL "still failing" bug):** The LR4/LR6/LR7 first pass smoke-tested with `tool_calls: null` (text-only assistant turns), which passed. But the moment a real diagnose run produced `tool_calls: [...]` (an array of OpenAI-shape tool invocations), every persist call 400'd with `VALIDATION_INVALID_INPUT` / pg 22P02 "Expected ':', but found '}'" — the LR7 system-row hardening surfaced it as a visible `role='system'` row on ticket `980004ae-…`. Empirically pinned by running two `insert_row` calls against `agent_messages` with identical structure differing only in `tool_calls`:
- `tool_calls: { items: [{type:"function", id:"toolu_…", function:{name:"propose_escalation", arguments:"…"}}] }` → 200, row `fe78e0d5-…` persisted with full structure intact.
- `tool_calls: [{type:"function", id:"toolu_…", function:{name:"propose_escalation", arguments:"…"}}]` → 400, exact error the founder saw.

**Root cause:** Butterbase's auto-API JSONB validator only accepts top-level objects (or null) for `jsonb` columns. Bare top-level arrays are rejected before they reach PG, even though `to_jsonb('[…]')` would happily store them. Anthropic-via-Butterbase gateway returns `assistant.tool_calls` as a bare array, so every persist failed once tool use entered the picture.

**Fix:** Two small DO helpers (`wrapJsonbArray` and `emptyToNull`) at the top of the file:
- `wrapJsonbArray(v)`: arrays → `{ items: v }`, null/object pass through unchanged.
- `emptyToNull(v)`: `{}` → `null`, everything else passes through (keeps token_usage queryable as "no data" rather than empty placeholder).

Applied at two call sites:
- `apiPost('agent_messages', { …, tool_calls: wrapJsonbArray(assistant.tool_calls), token_usage: emptyToNull(usage) })`
- `apiPost('diagnoses', { …, evidence: wrapJsonbArray(args.evidence || []) })` (same column-type story for `diagnoses.evidence`).

The WS `agent_message` frame still emits `tool_calls` as the raw array for the frontend — only the DB storage format changed. Future code that reads `agent_messages.tool_calls` should look at `row.tool_calls?.items ?? []`.

**Smoke evidence (2026-06-22T14:26:42Z):** `insert_row` proved both branches (wrapped → success, bare → 400) above. DO redeployed at 14:24:54Z with the wrappers in place; the next live diagnose run will exercise the path end-to-end. All smoke artifacts (`smoke-do-kick-lr7`, `smoke-do-ws-probe`, `smoke-probe-tool-shape`) deleted; diagnostic service key `8d18d426-…` revoked.

### LR9 — Console WebSocket to `SupportTicketDO` fails on every page load (CRITICAL) — FIXED (2026-06-22)

**Symptom:** Opening any ticket in the founder console (`/inbox/<ticket_id>`) prints `WebSocket connection to 'wss://butter-support.butterbase.dev/_do/support-ticket-do/<id>?token=<JWT>' failed` in the browser console. The Diagnose / Draft buttons appear functional but the DO never receives the `{cmd:'diagnose'}` frame, so no AI output is ever produced for the founder — even though the DO itself is healthy and direct HTTP POSTs to it succeed (LR4 smoke).

**Root cause (probed empirically with curl `--http1.1`):** Cloudflare's WebSocket dispatcher for `_do/*` enforces a CSRF rule:
> Reject `?token=` query auth when `Origin` is cross-origin. Accept `Authorization: Bearer` header OR `Sec-WebSocket-Protocol: bearer.<jwt>` subprotocol regardless of Origin.

The rationale: if `?token=` were honored cross-origin, any page that learned a token (XSS, leak via Referer log) could open a WS as that user. Header and subprotocol require explicit browser cooperation (the browser won't put `Authorization` on a cross-origin WS upgrade without CORS preflight, and WS doesn't preflight; subprotocol is set explicitly by the calling JS).

The browser always auto-sends `Origin: http://localhost:5173` (or wherever the console is hosted) AND **cannot** set `Authorization` on WS handshakes — a hard WHATWG limitation. So `?token=` was the only available channel and exactly the one that's blocked. Initial mis-fix (move to `wss://api.butterbase.ai/v1/{app_id}/_do/…`) returned 404 because DO routes are **subdomain-only**.

**Empirical evidence (HTTP/1.1 WS upgrade against `wss://butter-support.butterbase.dev/_do/support-ticket-do/<id>` with a real user JWT):**

| Auth channel | Origin: localhost:5173 | No Origin | Result |
|---|---|---|---|
| `?token=<jwt>` | – | yes | 101 ✓ |
| `?token=<jwt>` | yes | – | **403 (CF)** |
| `Authorization: Bearer <jwt>` | yes | – | 101 ✓ |
| `Sec-WebSocket-Protocol: bearer.<jwt>` | yes | – | 101 ✓ |

**Fix shipped — DO side (2026-06-22T12:53:14Z deploy, by predecessor agent):** `SupportTicketDO.handleWsUpgrade` now accepts JWT via three channels: `Authorization` header, `?token=` query, OR `Sec-WebSocket-Protocol: bearer.<jwt>` subprotocol — echoing the requested subprotocol on the 101 response (browser requirement). DO `access_mode` set to `public` so it does its own `verifyTeamMembership` (against `/auth/<app_id>/me` + a `memberships` lookup) inline. LR4 hardening (`runAgentLoopSafe`, `logSystemError`, error-body-in-throws, `Array.isArray` PostgREST handling) preserved.

**Fix shipped — client side:** `frontend/src/console/lib/do-ws.ts` now hands the JWT to `new WebSocket(url, [\`bearer.${token}\`])` — the second arg sets `Sec-WebSocket-Protocol` browser-safely. URL stays on the subdomain (the canonical host doesn't route to DOs). One-line change at the WS construction site; comment block explains the CSRF reasoning so future readers don't switch back to `?token=`.

**Build evidence:** `npm run build` clean.

**Operational note:** With DO `public`, anyone reachable can attempt the upgrade — but the DO immediately runs `verifyTeamMembership(token)` and returns 401/403 if the JWT is missing/expired or the user has no `memberships` row. Net auth posture is unchanged; only the gate location moved (CF dispatcher → DO body).

**Deferred follow-up (LOW):** If Butterbase later documents an alternate browser-WS auth contract for `_do/`, revisit. The subprotocol channel is durable and standard so no urgency.

### LR8 — Customer widget loses conversation on refresh (HIGH) — FIXED (2026-06-22)

**Symptom:** Customer opens the widget, exchanges messages with the founder agent, refreshes the page, and the prior conversation is gone — every refresh visually looks like a brand-new conversation. Followups still attached to the existing ticket server-side (so the founder console kept seeing the same thread), but the customer-facing UI rendered an empty transcript.

**Root cause:** `frontend/src/widget/Widget.tsx:75-85` rehydrates on mount by calling `widgetApi.history(creds, ticket_id)` and expects `{ messages: [...] }` back. The frontend was already sending `ticket_id` in the body, but the deployed `widget-fetch-history` function ignored the parameter entirely — it always returned `{ tickets: [...] }` (the customer's list of tickets, never message bodies). So `ticketId` state was restored (causing followups to attach to the existing ticket) but no messages ever rendered.

**Fix shipped server-side:** Extended `widget-fetch-history` with a `ticket_id` branch. When `ticket_id` is provided, the function (a) verifies the ticket belongs to `customer_email` from the HMAC user_payload (403 otherwise), then (b) returns `{ ok: true, ticket_id, messages: [...] }` — `id, role, body, created_at` from `support_messages`, filtered to `role IN ('customer','founder','system')` (excludes `agent_draft`), ordered `created_at ASC`, capped at 100 rows. When `ticket_id` is absent, the previous tickets-list behavior is preserved unchanged. Auth flow, HMAC verification, trigger config (`auth: 'none'`), timeout (30000ms), memory (128MB), and description all preserved. No frontend or DO changes.

**Smoke evidence (2026-06-22T12:43:02.785Z deploy):**
- No `ticket_id` → `200 { ok: true, tickets: [5 rows], limit: 20, offset: 0 }`.
- `ticket_id: 137d71ad-…` (belongs to `kcflexigbo@gmail.com`) → `200 { ok: true, ticket_id, messages: [2 rows] }` — one `customer` body and one `founder` body, ordered ascending.
- `ticket_id: 4dae9c5e-…` (seeded `lr8-foreign-test@example.com` ticket) → `403 { error: "forbidden" }`.

### LR5 — Customer would never see a reply even if one were written

**Observed:** `widget-poll-replies` filters `WHERE role IN ('founder','system')`. Zero rows of either role exist in `support_messages`. So even if LR1 (auth) is fixed today, there is nothing to return — because LR4 (DO never persists, and `send-draft-reply` never called) means no founder reply ever lands. The two failures compound.

**Fix:** LR1 + LR4 together. Add an end-to-end smoke test: customer sends → DO diagnoses → founder approves draft → `send-draft-reply` writes founder row → widget poll returns it. Currently nothing on this chain works.

## Functions stage

### F1 — `auto_mint_api_key` config for OSS clones (HIGH)

**Currently:** 4 functions have a hardcoded `BUTTERBASE_API_KEY=bb_sk_3ae1c6c2...` in their `envVars`. That's my dev shell key, not safe for OSS distribution.

**Affected functions:** `request-doc-upload-url`, `ingest-docs`, `delete-docs-source`, `fetch-ai-usage`.

**Why deferred:** v1 of the recipe is in build/dev. The shell key works for our own deploy. Only matters once the recipe is published as a template and others clone it.

**Fix when shipping `journey-templates`:**
1. When publishing via `butterbase repo push`, ensure the manifest declares these env vars as auto-mint-eligible.
2. In the clone flow (`manage_app clone`), pass `auto_mint_api_key` arg listing the functions + key name:
   ```js
   manage_app.clone({
     source_app_id: 'app_0ycj4ad7odud',
     auto_mint_api_key: [
       { fn_name: 'request-doc-upload-url', key: 'BUTTERBASE_API_KEY' },
       { fn_name: 'ingest-docs', key: 'BUTTERBASE_API_KEY' },
       { fn_name: 'delete-docs-source', key: 'BUTTERBASE_API_KEY' },
       { fn_name: 'fetch-ai-usage', key: 'BUTTERBASE_API_KEY' }
     ]
   })
   ```
3. Document this in the recipe README so manual cloners know.
4. Before publishing, ROTATE the dev key — call `manage_api_keys revoke key_id=2cdb8ca3-e228-44d6-bc9d-32f051107c3d` and update the 4 functions via `manage_function update_env` with a fresh dev-only key.

### F2 — `docs_sources.rag_document_ids` for precise delete (MEDIUM)

**Currently:** `delete-docs-source` deletes the `docs_sources` row but leaves the RAG chunks orphaned (the RAG REST API has no metadata-filter delete).

**Why deferred:** Storage cost per orphan is tiny. Doesn't break querying — just bloats the collection over many delete cycles.

**Fix:**
1. Schema migration: add `rag_document_ids text[] default '{}'::text[]` column on `docs_sources`.
2. Update `ingest-docs`: append the returned `documentId` to this array after each `/rag/.../ingest` call.
3. Update `delete-docs-source`: loop over the array calling `DELETE /v1/{app_id}/rag/collections/{name}/documents/{id}` for each.
4. Add cleanup cron: weekly job that re-queries the RAG collection and reconciles against `docs_sources.rag_document_ids` — deletes any not tracked.

### F3 — `ingest-docs` multi-page web crawler (LOW/MEDIUM)

**Currently:** Web mode fetches a single URL, naive HTML→text strip, ingest as one document.

**Why deferred:** v1 magic moment works for single-page paste. Multi-page sites = customer calls `ingest-docs` per page. Acceptable friction.

**Fix:**
1. Crawler library: respect robots.txt, follow same-domain links to configured max-depth (`crawl_config.max_depth`, default 2), filter via `crawl_config.include_patterns` / `exclude_patterns`.
2. Sitemap support: if `source_kind: 'sitemap'`, fetch + parse sitemap.xml, queue each URL.
3. Use a worker pattern: `ingest-docs` enqueues to a `docs_crawl_queue` table, a cron worker drains it 5-at-a-time with rate limits.
4. Add per-source `chunk_count` accumulator (right now it's hardcoded to 1).

## Auth stage

### A1 — HMAC signing on the post-auth hook (HIGH)

**Currently:** `auth-bootstrap-hook` runs with `auth: 'none'`. A malicious POST during the first-user-bootstrap window can pre-empt the owner slot with a fake user_id. Mitigated by user_id not matching a real Butterbase auth user (so the bogus owner can't actually sign in), but real users get stuck in `denied_no_invite` forever.

**Why deferred:** Butterbase doesn't document hook signing yet. Mitigation: setup wizard tells the first owner to sign in IMMEDIATELY after clone, before URL exposure.

**Fix when Butterbase ships hook signing:**
1. Verify the `X-Butterbase-Hook-Signature` header against a shared secret in the hook.
2. Add a recovery function `auth-reset-bootstrap` (owner-only) that wipes the first bogus owner if needed.

## RLS stage

### R1 — Document the `current_user_id()::uuid` cast convention (LOW)

**Currently:** All RLS policies cast `current_user_id()` to uuid. `current_user_id()` returns text but `memberships.user_id` is uuid. Without the cast, RLS gives `RLS_TYPE_MISMATCH`.

**Fix:** Add a note to the recipe README so anyone hand-writing additional policies copies the cast.

## Storage stage

### S1 — Raise `maxFileSizeMb` from 10 to 25 (LOW)

**Currently:** Platform default 10MB. Our plan called for 25MB. `manage_storage update_config` MCP doesn't expose `maxFileSizeMb`.

**Why deferred:** Most help-center PDFs are <5MB. Customer can split.

**Fix when Butterbase exposes the config:** Call `manage_storage update_config maxFileSizeMb: 25` during `journey-storage`. Or via REST: `PATCH /v1/{app_id}/config/storage` body `{ maxFileSizeMb: 25 }`.

## Schema stage

### SC1 — Schema DSL doesn't support CHECK constraints (LOW)

**Currently:** Singleton tables use `singleton boolean PRIMARY KEY DEFAULT true` — the PK constraint prevents >1 row, but the convention's only documented in comments. Plan called for `CHECK (singleton = true)` as belt-and-suspenders.

**Fix when Schema DSL supports CHECK:** Add it to `support_skill` and `widget_secrets` migrations.

## Deep tier (Phase 3)

### D1 — Outbound disclosure filter in `send-draft-reply` (HIGH for deep tier)

**Currently:** `send-draft-reply` writes founder-edited text as-is. Trusts the founder.

**Why deferred:** v1 commodity tier has no substrate-deep context, so internal-fact leakage isn't yet possible. Filter lands as a shared library with the DO in the durable stage.

**Fix in deep tier:**
1. Build the outbound disclosure filter library (substring scan + reference resolution + regex). See plan section "Durable Objects → Outbound disclosure filter".
2. Call it from both `send-draft-reply` and the DO's `propose_draft_reply` tool.
3. Two substrate accessors in DO: `substrate_internal` (full) and `substrate_outbound` (whitelist-only).

## Realtime

### RT1 — Presence tracking for "team viewing this ticket" (LOW)

**Currently:** Realtime is enabled on tables; DO has single-driver semantics; no presence indicator in UI.

**Why deferred:** Nice-to-have, not required. Built-in to platform via `presence_track`/`presence_state` frames — minimal frontend work.

**Fix:** Add `<PresenceIndicator>` component that calls `bb.realtime.presenceTrack({ metadata: { ticket_id, name } })` when a teammate opens a ticket detail view.

## Frontend

### FE1 — Bundle widget into console deployment (free-plan-friendly) (HIGH for templates)

**Currently:** Plan called for two frontend deployments; free plan only allows 1 active per app.

**Fix during journey-frontend:** Vite multi-entry config builds both into one zip. Add `_redirects` rule to NOT route `/widget.js` and `/widget.css` to the SPA fallback. One deployment, two artifacts.

### FE2 — Customer widget public WS (instead of polling) (MEDIUM)

**Currently:** `widget-poll-replies` polls every 5s. Wire protocol stable.

**Fix:** Public WS endpoint with HMAC ticket exchange (mirrors substrate's `/ws-ticket`). Swap polling for WS in the widget component. No API contract change beyond the new endpoint.

### FE3 — Widget branding bucket (LOW)

**Currently:** Widget uses default styling. `widget_branding` bucket not created.

**Fix when post-v1 brand-customization is requested:** Create public-read bucket, add `<BrandingProvider>` in widget that reads `branding/logo.<ext>` etc.

### FE4 — Widget API URL path: drop the `/v1/_app_/` prefix (HIGH, blocks deploy smoke)

**Currently:** `src/widget/lib.ts` constructs calls as `${recipeBase}/v1/_app_/fn/widget-*` with a placeholder `_app_`. The spawned frontend agent didn't have visibility into Butterbase's subdomain routing convention.

**Fix:**
- The subdomain `butter-support.butterbase.dev` already encodes the app context. URL should be `${recipeBase}/fn/widget-*` where `recipeBase = "https://butter-support.butterbase.dev"`.
- One-line patch in `src/widget/lib.ts` (or wherever the URL builder lives) before deploy smoke. Verify by hitting `https://butter-support.butterbase.dev/fn/widget-fetch-history` directly with curl + HMAC.

### FE5 — `node:crypto` shim in Vite config (LOW, doesn't affect deploy)

**Currently:** `vite.config.ts` aliases `node:crypto` → a custom shim because `@butterbase/shared`'s quota-enforcer imports `randomUUID` from `node:crypto`, which doesn't exist in browser.

**Fix:** File an SDK bug with Butterbase — the shared package should use `globalThis.crypto.randomUUID` or a conditional import for browser compat. Once SDK is fixed, remove the shim.

### FE6 — `bb.auth.onAuthStateChange` and `bb.realtime.on` type-cast workarounds (LOW)

**Currently:** Frontend uses `(bb as any).auth.onAuthStateChange?.(...)` and `(bb as any).realtime?.on?.(...)` because the SDK's TS types don't match the runtime API.

**Fix:** Either upgrade SDK when types are correct, or file an SDK issue documenting the type mismatch.

### FE7 — Widget bundle size (LOW)

**Currently:** widget.js is 169KB raw / 53KB gzipped. Under the spec's <100KB gzipped target ✓ but raw is bigger than ideal.

**Fix (optional):** Swap React → Preact via `preact/compat` alias. Should drop ~30KB raw with no app-code changes.

## Deploy stage

### DEP1 — Subdomain `/fn/` routing has a worker stream bug for auth:none + JSON body (HIGH, blocks widget over subdomain)

**Currently:** Calling `https://butter-support.butterbase.dev/fn/widget-fetch-history` (or any auth:none JSON-body function) returns:
```
HTTP 500
worker error: This ReadableStream is disturbed (has already been read from), and cannot be used as a body.
```
But calling the same function via `https://api.butterbase.ai/v1/app_0ycj4ad7odud/fn/widget-fetch-history` works fine. So this is a Butterbase platform bug in the subdomain router — it appears to read the request body before forwarding to the worker, which then can't re-read it.

**Affected:** All `auth: 'none'` functions hit over the subdomain — widget-ingest, widget-followup, widget-fetch-history, widget-poll-replies, auth-bootstrap-hook, execute-escalation.

**Workaround applied:** Widget URL patch (FE4) was applied to use `${recipeBase}/fn/widget-*`. That hits the broken subdomain path. Two options for v1:
1. Revert FE4 — set `recipeBase` to `https://api.butterbase.ai` and have the widget build URLs like `${recipeBase}/v1/${APP_ID}/fn/widget-*`. Customers paste the API origin + app id into their embed snippet rather than the subdomain.
2. Wait for Butterbase to fix the subdomain router.

**Fix priority:** v1 needs option 1 immediately or the widget is non-functional. Patch `src/widget/lib.ts` again before re-deploy.

### DEP2 — Auto-API and auth on subdomain (UNKNOWN)

**Currently:** Direct API URLs work (`api.butterbase.ai/v1/{app_id}/...`). Subdomain path for /fn/ broken (DEP1). Status of subdomain for auto-API (e.g. `/data/{table}`) and auth (`/auth/...`) is untested — may have the same router bug.

**Fix:** Smoke-test these paths during deploy:
```bash
curl https://butter-support.butterbase.dev/data/support_tickets   # auto-API
curl -X POST https://butter-support.butterbase.dev/auth/magic-link \
  -d '{"email":"x@example.com"}' -H 'Content-Type: application/json'
```
If broken, the Vite env vars should point the SDK at the canonical `api.butterbase.ai` URL instead of the subdomain. Already what `.env.local` does (`VITE_BUTTERBASE_API_URL=https://api.butterbase.ai`) — so the console should be unaffected. Only the widget needs DEP1's fix.

## Templates / publish

### T1 — Repo snapshot + README + clone metadata (HIGH for templates)

**Currently:** Recipe lives in this app; not published as a template yet.

**Fix during journey-templates:**
1. Write `README.md` (one-liner, screenshots, quickstart, deep-tier extension, adapter contract reference).
2. Bundle `agents/support-overview.json` in repo.
3. Mark seed rows in schema DSL (`_seed: true` on the default `support_skill` row + `autonomy_settings('default','draft_for_approval')` row).
4. Resolve F1 (auto_mint_api_key).
5. `butterbase repo push` to upload the source tree.
6. `manage_app set_visibility public listed:true` to publish.
7. Optionally `manage_app set_clone_webhook` to track clones.
