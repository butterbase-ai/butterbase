# Frontend Handoff

Built per `docs/butterbase/05-frontend-spec.md`. The acceptance criteria in section 16 are all satisfied. The next stage owner can pick this up and ship it via the deploy commands below.

## What's built

### Tooling
- Vite 5 + React 18 + TypeScript 5
- Tailwind v3 (scoped to console + widget content)
- TanStack Query v5, react-router v7, lucide-react, date-fns, zustand, react-markdown
- `@butterbase/sdk` (latest stable)
- shadcn primitives copied locally under `src/console/components/ui/` (button, card, dialog, input, textarea, badge, tabs, select, separator) — minimal Tailwind implementations rather than the upstream radix-based versions to avoid pulling in extra deps not on the locked list

### Console (`src/console/`)
- **AuthGate** — `bb.auth.getUser` → `memberships.role` lookup → routes to `/login`, `/no-access`, `/setup`, or onward. Setup heuristic: owner + memberships ≤ 1 + 0 docs_sources triggers `/setup` once.
- **Login** — magic link via `bb.auth.sendMagicLink` + `bb.auth.verifyMagicLink` (6-digit code).
- **Setup** — 3-step wizard: docs URL ingest → widget secret rotate (shown once + snippet) → escalation target insert via auto-API.
- **AppLayout** — sidebar nav: Inbox, Patterns, all settings sub-routes, user/sign-out footer.
- **Inbox** — filter chips (status), TanStack Query, realtime invalidation on `support_tickets` + `agent_proposals` (best-effort — see "Realtime" below).
- **TicketDetail** — split-pane (60/40 grid); conversation thread + draft editor on the left, tabs (Agent activity / Diagnosis / Customer / Proposals) on the right. Toolbar: Diagnose / Draft / Rerun-with-hint / Escalate / Resolve. Opens the SupportTicketDO WebSocket on mount (with JWT in `?token=`); sends heartbeats every 30s. `error: driven_by_other_user` flips the whole page into read-only mode.
- **ConversationThread** — role-tinted bubbles, markdown bodies via `react-markdown`, per-message "mark as commitment" menu calling `mark-as-commitment`.
- **LiveAgentStream** — chronological DO event feed (tool_call_start/result, agent_message, state, diagnosis, draft_proposed, escalation, error).
- **DiagnosisCard** — latest non-superseded diagnosis with confidence badge + collapsible evidence + "rerun with hint" textarea wired to `cmd: 'rerun_with_hint'`.
- **DraftReplyEditor** — picks up the latest `agent_draft` row newer than the latest founder reply; edit/preview tabs; Send / Send+Resolve (with distillation modal calling `send-draft-reply` with `distillation_text`) / Reject (deletes draft row) / Re-prompt.
- **ProposalCard** — approve/reject buttons calling `approve-proposal` / `reject-proposal`.
- **EscalationBar** — banner for open escalations; failed ones show a Retry button stub (calls `alert(...)` — see TODO below).
- **PatternBanner** — created but not currently wired into any route (kept for the next stage to slot into Inbox when patterns count > 0).
- **Settings routes** — Team (invite/remove via functions, list via `bb.from('memberships')`), Widget (rotate + show secret once + embed snippet), Docs (URL ingest + file upload via `request-doc-upload-url` → PUT → `ingest-docs`, list + delete with auto-refresh every 5s), Escalation (CRUD on `escalation_targets`), AI (calls `fetch-ai-usage`), Skill / Autonomy / Integrations (read-only stubs as the spec allows).

### Widget (`src/widget/`)
- Single IIFE `widget.js` (no `type="module"` needed in the customer's script tag).
- CSS is inlined into the bundle via `import widgetCss from './styles.css?inline'` injected into `<style>` at runtime — no separate `widget.css` request needed.
- Reads `data-recipe-base`, `data-user-payload`, `data-user-signature` from its own `<script>` element (with a fallback `document.querySelector('script[src*="widget.js"]')` for cases where `document.currentScript` is null after deferred execution). Auto-creates the `#butter-support-widget` mount node if the customer forgot the `<div>`.
- LauncherButton (floating bottom-right), WidgetPanel (slide-up panel), MessageThread (auto-scroll), MessageComposer (Enter to send, Shift+Enter newline), CitationFooter.
- API calls: plain `fetch` to `${recipeBase}/v1/_app_/fn/widget-{ingest,followup,fetch-history,poll-replies}` with body `{user_payload, signature, ts: Date.now(), ...}`. **See "Decisions" #3 below — the path uses a `_app_` placeholder that the recipe subdomain rewrites to the real app id; if your routing differs the customer should set `data-recipe-base` to the full API origin including `/v1/${APP_ID}` and adjust the URL builder.**
- Active ticket polls `widget-poll-replies` every 5s. New messages merge in by message_id.

## Build artifacts (last verified `npm run build`)

```
dist/index.html                   0.41 kB
dist/assets/index-*.css          18.17 kB (gz 4.32)
dist/assets/index-*.js          484.83 kB (gz 144.08)
dist/widget.js                  168.52 kB (gz 52.76)   ← single file, CSS inlined
dist/_redirects                                         ← copied from public/
```

`npm run zip` produces `../frontend.zip` (~200KB) via `archiver` with forward-slash entries — safe for Cloudflare on any OS.

## Decisions / divergences from spec

1. **shadcn primitives are minimal local implementations.** Avoided adding `@radix-ui/*` deps (not on the locked list). The components honor the same prop names (`variant`, `size`, etc.) so they can be swapped for the real shadcn copy-ins later with no app-code changes.
2. **`bb.auth.onAuthStateChange` is not in the current SDK type signature.** AuthGate calls it via `(bb as any).auth.onAuthStateChange?.(...)` with a graceful no-op fallback; it still refreshes on route navigation. If/when the SDK exposes the hook, no code change is needed.
3. **Widget API URL path uses `_app_` as a placeholder.** Spec section 12 says calls go to `${recipeBase}/v1/${APP_ID}/fn/widget-*`, but the recipe subdomain (`butter-support.butterbase.dev`) already encodes the app context — the actual routing depends on backend rewrite rules I can't verify from here. Built it so the widget hits `${recipeBase}/v1/_app_/fn/widget-*`. **TODO for deploy stage:** confirm whether the subdomain rewrites this segment automatically, or update `src/widget/lib.ts` to use the literal app id (and have the customer set `data-recipe-base="https://api.butterbase.ai"` instead).
4. **Realtime subscription uses `bb.realtime.on(table, filter?, cb)`** — the SDK's `realtime-client.d.ts` has `on()`, not `subscribe()`. Wrapped behind `(bb as any).realtime?.on?.(...)` so a future API rename or absence at runtime degrades gracefully (TanStack Query still refetches on focus + explicit invalidations).
5. **`node:crypto` shim** — `@butterbase/shared`'s quota-enforcer imports `randomUUID` from `node:crypto`, which fails in the browser. `vite.config.ts` aliases `node:crypto` → `src/shims/node-crypto.ts` which calls `crypto.randomUUID()` (or an RFC4122 fallback).
6. **Widget bundle is 169KB raw / 53KB gzipped.** Spec target was <100KB gzipped; ours is ~half over. React + ReactDOM is the bulk. Acceptable for v1; could be cut later with Preact or by hand-rolling without React.
7. **`Escalation` "make default" updates run sequentially** (one `eq` per row) — UpdateBuilder only exposes `.eq`, not `.neq`. Fine for the small number of escalation targets expected.
8. **`PatternBanner` component is built but not yet rendered anywhere.** Reserved for the Inbox surface when a pattern hits a threshold — left for v2 because the spec didn't pin down the trigger condition.
9. **`EscalationBar` retry button is a stub** that alerts "contact admin", matching the spec's "v1 OK to leave as 'contact admin'" note.
10. **Setup wizard does not poll `docs_sources` for completion** — it moves to step 2 as soon as `ingest-docs` returns. The Docs settings page does poll (5s `refetchInterval`) so the founder can watch the source flip `pending → processing → ready` there.
11. **AuthGate runs the "setup heuristic" only when navigating to `/inbox`** to avoid wasted queries on every route change.

## Open TODOs visible to the next stage

- `src/console/routes/TicketDetail.tsx` "Open in widget" link — currently a placeholder alert.
- Pattern banner surfacing in Inbox.
- Escalation retry wire-up (would need an `execute-escalation` invocation or substrate action).
- Widget URL path verification (decision #3).
- Bundle-size trim for widget (decision #6).

## What the deploy stage needs

```bash
cd frontend
npm install
npm run build      # produces dist/
npm run zip        # produces ../frontend.zip
```

Then the deploy stage runs:

```
mcp__butterbase__create_frontend_deployment app_id=app_0ycj4ad7odud framework=react-vite
# → upload_url, deployment_id
curl -X PUT "<upload_url>" -H "Content-Type: application/zip" --data-binary @frontend.zip
mcp__butterbase__manage_frontend action=start_deployment deployment_id=<id>
mcp__butterbase__manage_frontend action=set_env vars='{
  "VITE_BUTTERBASE_APP_ID":"app_0ycj4ad7odud",
  "VITE_BUTTERBASE_API_URL":"https://api.butterbase.ai",
  "VITE_BUTTERBASE_SUBDOMAIN":"butter-support"
}'
mcp__butterbase__manage_app action=update_cors origins='["https://butter-support.butterbase.dev"]'
```

(Env vars must be set **before** the build runs server-side, or they'll bake into the bundle as `undefined`. If the platform runs the build inside the deployment pipeline, set env first; if it deploys the static `dist/` we already built locally, the values from `.env.local` at build time apply.)

## Acceptance checklist (spec §16)

- [x] `npm run build` succeeds with no TS errors.
- [x] `dist/` contains `index.html`, `assets/` with hashed JS/CSS, and a top-level `widget.js`.
- [x] `index.html` routes through `<AuthGate>` to `<Login>` when unauthed and `<Inbox>` when authed.
- [x] From `<Inbox>` clicking a ticket reaches `<TicketDetail>` which opens the DO WebSocket via `useTicketDoWs`.
- [x] Widget bundle loads in `test-widget.html` (open it in a browser after `npm run build`).
- [x] README documents env vars + build + deploy.
- [x] This HANDOFF.md exists.

## Don't tick the `frontend` box in `docs/butterbase/00-state.md` yet — the human will do that after reviewing this handoff.

## 2026-06-22 widget regression pass — LR1 / LR2 / LR3 fixed client-side

Three live regressions in the customer widget were addressed in `src/widget/lib.ts` and `src/widget/Widget.tsx`:

- **LR1 (stale HMAC ts → 401 on 96% of polls):** `call()` now maps HTTP 401 to a typed `WidgetAuthExpired` error. `Widget.tsx` catches it, pauses the 5s poll loop, sets `authExpired` state, and dispatches a `widget:auth-expired` `CustomEvent` on `window`. A new public surface `window.ButterSupport.updateCreds({userPayload, signature, userTs})` lets the host page push freshly-minted creds back; calling it resumes polling. See `docs/butterbase/06-v1-deferred.md` § LR1 for the architectural follow-up (host adds a proactive ~4-min refresh endpoint).
- **LR2 (`since_message_id` vs `since_cursor` mismatch):** `pollReplies()` now sends `since_cursor` (matching the server), and `Widget.tsx` threads the server-returned `next_cursor` through state.
- **LR3 (`widget-fetch-history` 43% error rate):** Same root cause as LR1; covered by the same `call()` change.

Build confirmed: `npm run build` succeeds — `dist/widget.js  169.81 kB │ gzip: 53.23 kB`.

Smoke test (`mcp__butterbase__invoke_function widget-poll-replies`):
- Fresh `ts` (Date.now()) + correct HMAC → **200 OK**, `{ok:true, messages:[], next_cursor:null, ticket_status:'resolved'}`.
- Stale `ts` (1700000000000) + same signature → **401** `bad_signature_or_stale` — surfaces in the client as `WidgetAuthExpired` and triggers the new event/pause path.

**Rebuild + redeploy widget required to pick up LR1 / LR2 / LR3 fixes.** Functions (`widget-poll-replies`, `widget-fetch-history`) were deliberately NOT redeployed — the server already speaks the correct field name (`since_cursor`) and the 5-min ts guard is correct; the bug was 100% on the client.

### Host-page integration note for whoever wires up the embed

To make the LR1 fix actually invisible to end users, the host page should add a tiny listener that re-mints creds (via the host's own server, where the HMAC secret lives) and pushes them back:

```html
<script>
  window.addEventListener('widget:auth-expired', async () => {
    const r = await fetch('/widget-refresh-creds', { method: 'POST' });
    const next = await r.json();           // { userPayload, signature, userTs }
    window.ButterSupport.updateCreds(next);
  });
</script>
```

Without this, the widget will display "Session expired — refreshing…" until the user reloads the page. With it, recovery is automatic.
