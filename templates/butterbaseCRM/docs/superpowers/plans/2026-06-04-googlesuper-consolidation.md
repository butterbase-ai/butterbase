# Google Super Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate `gmail` and `google-calendar` Composio toolkits with a single `googlesuper` connection so a user clicks "Connect Google" once and both Gmail ingest and Calendar ingest work off the same OAuth.

**Architecture:** Composio's `googlesuper` toolkit ships one OAuth connection with the union of Google scopes and exposes the full `GMAIL_*` and `GOOGLECALENDAR_*` action surface. We change every place that says "gmail" or "google-calendar" (toolkit slugs, OAuth init, register/unregister, ingest binding checks, Settings UI) to use the single `googlesuper` slug. Sync state stays split into two `integration_state` rows (`kind='gmail'` and `kind='calendar'`) because the two ingest functions run independently and we want per-service "last synced / last error" telemetry. Existing connected users will need to reconnect once.

**Tech Stack:** Composio (`googlesuper` toolkit), Butterbase MCP (`manage_integrations`), Cloudflare Workers / Butterbase Functions (TypeScript), React + TanStack Query + Butterbase SDK (`bb.integrations`).

---

## File Inventory

**Modify:**
- `backend/integrations/integrations.json` — replace `gmail` entry with `googlesuper`
- `backend/functions/register-integration/handler.ts` — no slug-specific logic, but update the docstring example
- `backend/functions/unregister-integration/handler.ts` — `TOOLKIT_TO_STATE_KIND` map: one slug → two state kinds
- `backend/functions/ingest-gmail/handler.ts` — binding check uses `googlesuper` instead of `gmail`
- `backend/functions/ingest-calendar/handler.ts` — binding check uses `googlesuper` instead of `google-calendar`
- `frontend/src/pages/Settings.tsx` — collapse two `IntegrationCard`s into one, single connect/disconnect handler, single busy state
- `frontend/src/pages/OAuthCallback.tsx` — already routes by `?integration=` param, just stops needing the `calendar → google-calendar` rewrite

**One-off operational step (not a file):**
- Call Butterbase `manage_integrations` MCP tool to configure the `googlesuper` toolkit for the app (produces a new `composio_auth_config_id`).

**No schema changes.** `workspace_integrations` and `integration_state` rows for existing users will be left in place; the disconnect-then-reconnect flow in Task 8 handles them.

---

## Task 1: Configure `googlesuper` toolkit on the Butterbase app

**Files:** (operational only — no code edit yet)

- [ ] **Step 1: Verify googlesuper exists in Composio**

Run via MCP:
```
mcp__butterbase__butterbase_docs topic="integrations"
```
Expected: documentation that confirms `googlesuper` is a valid `toolkit_slug` for `manage_integrations.configure`.

- [ ] **Step 2: Configure the toolkit**

Call:
```
mcp__butterbase__manage_integrations
  action: "configure"
  toolkit_slug: "googlesuper"
  enabled: true
  scopes: []   # use Composio's managed OAuth defaults
  purpose: "Single Google connection: send invite emails (Gmail), ingest emails + calendar events"
```
Expected: returns a new `composio_auth_config_id` (e.g. `ac_XXXXXXX`). Save this value — it goes into `integrations.json` in Task 2.

- [ ] **Step 3: Sanity-check via list**

Call:
```
mcp__butterbase__manage_integrations action: "list"
```
Expected: `googlesuper` appears with `enabled: true`. The old `gmail` entry may still be there; leave it for now (Task 9 retires it).

- [ ] **Step 4: Commit nothing yet** — this task only touches the platform, not the repo.

---

## Task 2: Update `integrations.json`

**Files:**
- Modify: `backend/integrations/integrations.json`

- [ ] **Step 1: Replace the gmail entry with googlesuper**

Open `backend/integrations/integrations.json` and replace its entire contents with:

```json
{
  "_source": "manage_integrations action: configure (googlesuper rollout 2026-06-04)",
  "configured": [
    {
      "toolkit_slug": "googlesuper",
      "composio_auth_config_id": "<paste-id-from-task-1-step-2>",
      "enabled": true,
      "scopes": [],
      "purpose": "Single Google connection — sends invite emails via GMAIL_SEND_EMAIL, ingests inbox via GMAIL_FETCH_EMAILS, ingests calendar via GOOGLECALENDAR_EVENTS_LIST"
    }
  ],
  "_note": "Each end user must connect Google once via integrations.connect('googlesuper'). Previously this app used two separate toolkits (gmail + google-calendar). Users connected before 2026-06-04 must reconnect once."
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/integrations/integrations.json
git commit -m "feat(integrations): switch to single googlesuper toolkit"
```

---

## Task 3: Update `ingest-gmail` binding check

**Files:**
- Modify: `backend/functions/ingest-gmail/handler.ts:71`

- [ ] **Step 1: Change the toolkit_slug used in the binding query**

In `backend/functions/ingest-gmail/handler.ts`, find the binding check (around line 69–77):

```ts
  const bind = await ctx.db.query(
    'SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2 AND toolkit_slug = $3 LIMIT 1',
    [workspaceId, userId, 'gmail'],
  );
  if (bind.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'not_bound', detail: 'Gmail is not wired to this workspace. Connect it from Settings.' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  }
```

Replace with:

```ts
  const bind = await ctx.db.query(
    'SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2 AND toolkit_slug = $3 LIMIT 1',
    [workspaceId, userId, 'googlesuper'],
  );
  if (bind.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'not_bound', detail: 'Google is not connected to this workspace. Connect it from Settings.' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  }
```

Leave `integration_state` rows still keyed on `kind='gmail'` — that's per-service sync watermark, not per-toolkit binding. Don't touch those queries.

- [ ] **Step 2: Deploy and smoke-test (after Task 5 also lands)**

This task only ships meaningfully once Tasks 3–5 are all merged. Deferred to Task 7.

- [ ] **Step 3: Commit**

```bash
git add backend/functions/ingest-gmail/handler.ts
git commit -m "feat(ingest-gmail): require googlesuper binding"
```

---

## Task 4: Update `ingest-calendar` binding check

**Files:**
- Modify: `backend/functions/ingest-calendar/handler.ts:68`

- [ ] **Step 1: Change the toolkit_slug used in the binding query**

In `backend/functions/ingest-calendar/handler.ts`, find the binding check (around line 66–74):

```ts
  const bind = await ctx.db.query(
    'SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2 AND toolkit_slug = $3 LIMIT 1',
    [workspaceId, userId, 'google-calendar'],
  );
  if (bind.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'not_bound', detail: 'Google Calendar is not wired to this workspace. Connect it from Settings.' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  }
```

Replace with:

```ts
  const bind = await ctx.db.query(
    'SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2 AND toolkit_slug = $3 LIMIT 1',
    [workspaceId, userId, 'googlesuper'],
  );
  if (bind.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'not_bound', detail: 'Google is not connected to this workspace. Connect it from Settings.' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  }
```

Leave `integration_state` rows still keyed on `kind='calendar'`. Leave the `CANDIDATE_TOOLS` array (`GOOGLECALENDAR_EVENTS_LIST` etc.) alone — those tool names are unchanged in `googlesuper`.

- [ ] **Step 2: Commit**

```bash
git add backend/functions/ingest-calendar/handler.ts
git commit -m "feat(ingest-calendar): require googlesuper binding"
```

---

## Task 5: Update `unregister-integration` mapping

**Files:**
- Modify: `backend/functions/unregister-integration/handler.ts:18-21`

- [ ] **Step 1: Replace the toolkit→state-kind map with one-to-many**

In `backend/functions/unregister-integration/handler.ts`, find:

```ts
const TOOLKIT_TO_STATE_KIND: Record<string, string> = {
  'gmail': 'gmail',
  'google-calendar': 'calendar',
};
```

Replace with:

```ts
// One toolkit (googlesuper) maps to multiple integration_state rows — Gmail and
// Calendar each track their own watermark even though they share an OAuth.
const TOOLKIT_TO_STATE_KINDS: Record<string, string[]> = {
  'googlesuper': ['gmail', 'calendar'],
};
```

- [ ] **Step 2: Update the state-clearing block to loop**

Find the block (around line 62–69):

```ts
  // Clear local sync state for this workspace+kind so the UI shows "never synced" again.
  const stateKind = TOOLKIT_TO_STATE_KIND[toolkit];
  if (stateKind) {
    await ctx.db.query(
      'DELETE FROM integration_state WHERE workspace_id = $1 AND kind = $2',
      [workspaceId, stateKind],
    );
  }
```

Replace with:

```ts
  // Clear local sync state for every kind this toolkit drives, so the UI shows "never synced" again.
  const stateKinds = TOOLKIT_TO_STATE_KINDS[toolkit] ?? [];
  for (const kind of stateKinds) {
    await ctx.db.query(
      'DELETE FROM integration_state WHERE workspace_id = $1 AND kind = $2',
      [workspaceId, kind],
    );
  }
```

- [ ] **Step 3: Commit**

```bash
git add backend/functions/unregister-integration/handler.ts
git commit -m "feat(unregister-integration): map googlesuper to gmail+calendar state"
```

---

## Task 6: Collapse Settings UI to one "Google" card

**Files:**
- Modify: `frontend/src/pages/Settings.tsx` (multiple sections)

- [ ] **Step 1: Replace state variables and lookups**

In `frontend/src/pages/Settings.tsx`, find (around lines 335–349):

```tsx
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  ...
  const gmail = connected.find(
    (c) => c.toolkit_slug === 'gmail' && c.status === 'active',
  );
  const calendar = connected.find(
    (c) => c.toolkit_slug === 'google-calendar' && c.status === 'active',
  );
  const gmailState = integrationStates.find((s) => s.kind === 'gmail');
  const calendarState = integrationStates.find((s) => s.kind === 'calendar');
```

Replace with:

```tsx
  const [googleConnecting, setGoogleConnecting] = useState(false);
  ...
  const google = connected.find(
    (c) => c.toolkit_slug === 'googlesuper' && c.status === 'active',
  );
  // Per-service sync watermarks (one OAuth, two ingest pipelines).
  const gmailState = integrationStates.find((s) => s.kind === 'gmail');
  const calendarState = integrationStates.find((s) => s.kind === 'calendar');
  // Back-compat: detect legacy connections so we can prompt a reconnect.
  const legacyGmail = connected.find((c) => c.toolkit_slug === 'gmail' && c.status === 'active');
  const legacyCalendar = connected.find((c) => c.toolkit_slug === 'google-calendar' && c.status === 'active');
  const needsLegacyReconnect = (!!legacyGmail || !!legacyCalendar) && !google;
```

- [ ] **Step 2: Replace the four old handlers with two new ones**

Find the four handlers `handleConnectGmail`, `handleDisconnectGmail`, `handleConnectCalendar`, `handleDisconnectCalendar` (lines 385–439). Delete all four and replace with:

```tsx
  async function handleConnectGoogle() {
    setGoogleConnecting(true);
    try {
      const redirectUrl = `${window.location.origin}/auth/callback?integration=googlesuper`;
      const { data, error } = await bb.integrations.connect('googlesuper', { redirectUrl });
      if (error) throw error;
      if (!data?.authUrl) throw new Error('No authorisation URL returned');
      window.location.href = data.authUrl;
    } catch (e) {
      setGoogleConnecting(false);
      toast.error(e instanceof Error ? e.message : 'Could not start Google connection');
    }
  }

  async function handleDisconnectGoogle() {
    if (!ws) return;
    try {
      // Disconnect legacy slugs too in case a user has both old + new bindings
      // mid-migration. Ignore individual failures — best-effort cleanup.
      const slugs = ['googlesuper', 'gmail', 'google-calendar'];
      for (const slug of slugs) {
        await bb.functions
          .invoke('unregister-integration', { body: { workspace_id: ws, toolkit: slug } })
          .catch(() => undefined);
      }
      toast.success('Google disconnected');
      refetchConnected();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Disconnect failed');
    }
  }
```

- [ ] **Step 3: Replace the two IntegrationCard renders with one**

Find the two `<IntegrationCard>` calls (lines 598–627). Delete both and replace with:

```tsx
            <IntegrationCard
              icon={<GoogleMark />}
              name="Google"
              tagline="One connection for Gmail + Calendar — outreach, invites, and meeting sync."
              connected={!!google}
              loading={cLoading}
              connectedMeta={
                google
                  ? `connected ${formatDistanceToNowStrict(new Date(google.connected_at), { addSuffix: true })}`
                  : undefined
              }
              busy={googleConnecting}
              onConnect={handleConnectGoogle}
              onDisconnect={handleDisconnectGoogle}
            />

            {needsLegacyReconnect && (
              <div className="card-flat p-4 border border-coral/40 bg-coral/5">
                <p className="text-[13px] text-foreground">
                  <span className="font-mono text-coral">Action needed:</span>{' '}
                  Your Gmail / Calendar connections use an older format. Click
                  <span className="font-mono"> Connect Google </span>
                  above once to consolidate — your existing data stays intact.
                </p>
              </div>
            )}
```

- [ ] **Step 4: Update the "Sync from Google" card condition**

Find (line 629):

```tsx
            {(gmail || calendar) && (
```

Replace with:

```tsx
            {google && (
```

The Gmail/Calendar `last_synced_at` rows inside that block stay as they are — they read from `gmailState` / `calendarState`, which are still populated by the two ingest functions independently.

- [ ] **Step 5: Update the invite-section blurb references to `gmail`**

Find (around lines 683–687):

```tsx
            blurb={
              gmail
                ? 'A magic link will be emailed from your Gmail. Expires in 7 days.'
                : 'Without Gmail connected, the link is copied to your clipboard.'
            }
```

Replace with:

```tsx
            blurb={
              google
                ? 'A magic link will be emailed from your Gmail. Expires in 7 days.'
                : 'Without Google connected, the link is copied to your clipboard.'
            }
```

Find (around line 723):

```tsx
              {!gmail && (
```

Replace with:

```tsx
              {!google && (
```

And the message inside:

```tsx
                  <p className="text-[12.5px] text-foreground/80 leading-snug">
                    Connect Gmail above to automatically email invites instead of copying links.
                  </p>
```

Replace with:

```tsx
                  <p className="text-[12.5px] text-foreground/80 leading-snug">
                    Connect Google above to automatically email invites instead of copying links.
                  </p>
```

- [ ] **Step 6: Add a `GoogleMark` icon component**

At the bottom of the file, next to the existing `GmailMark()` function, add:

```tsx
function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/>
      <path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"/>
    </svg>
  );
}
```

You may now remove the old `GmailMark()` if you confirm it's no longer referenced anywhere in the file (search for `GmailMark` first). If it's still referenced elsewhere outside `Settings.tsx`, leave it.

- [ ] **Step 7: Delete the unused `Mail` lucide import if no longer used**

Search the file for `<Mail` after edits. If absent, remove `Mail,` from the import block at the top (line 22). Same for `CalendarIcon` (line 31): keep only if still referenced.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/Settings.tsx
git commit -m "feat(settings): collapse Gmail+Calendar into one Google connection"
```

---

## Task 7: Deploy and smoke-test end-to-end

**Files:** (operational, no edits)

- [ ] **Step 1: Deploy backend functions**

Run (or via MCP `deploy_function`):

```
mcp__butterbase__deploy_function function: "ingest-gmail"
mcp__butterbase__deploy_function function: "ingest-calendar"
mcp__butterbase__deploy_function function: "unregister-integration"
```

Expected: each returns `{ ok: true }`. `register-integration` was not modified, no redeploy needed.

- [ ] **Step 2: Deploy frontend**

Run the project's standard frontend deploy (check `package.json` scripts; likely `npm run build && bb deploy` or via `mcp__butterbase__create_frontend_deployment`). Expected: deployment succeeds and the live URL serves the new Settings page.

- [ ] **Step 3: Manual smoke — fresh connection**

In a browser logged in as a test user with no existing Google connection:
1. Visit `/settings`.
2. Click **Connect Google**. OAuth screen appears with combined Gmail+Calendar scopes. Approve.
3. Redirected back to `/settings`. Toast says "Googlesuper connected" (or similar).
4. Card shows **connected**.
5. Click **Sync now**. Toast reports `Gmail: scanned N, …` and `Calendar: scanned N, …`.

Expected pass: both lines show `scanned > 0` and no error, OR a clean explanation if the test account has no inbox/events.

- [ ] **Step 4: Manual smoke — disconnect**

Click **Disconnect** on the Google card. Confirm:
- Toast says "Google disconnected".
- Card returns to **not connected**.
- Sync card disappears (since `google` is now falsy).
- Re-clicking **Sync now** is impossible (button gone) — verify the underlying functions return 409 `not_bound` if hit directly via `bb.functions.invoke`.

- [ ] **Step 5: Commit anything that fell out of smoke**

If smoke surfaced bugs, fix them as inline edits, then:

```bash
git add -A
git commit -m "fix(googlesuper): post-smoke fixes"
```

---

## Task 8: Handle legacy connections for existing users

**Files:** (no code edits — UX/communication step)

- [ ] **Step 1: Verify the legacy banner triggers**

Manually create a `workspace_integrations` row with `toolkit_slug='gmail'` for a test workspace (use Butterbase MCP `insert_row` or SQL). Visit `/settings` as that user. Confirm the orange "Action needed" banner from Task 6 Step 3 appears.

- [ ] **Step 2: Confirm reconnect cleans up**

Click **Connect Google** in that state, complete OAuth, then verify:
- The legacy `gmail` (or `google-calendar`) row is **not** automatically removed — that's fine, because `handleDisconnectGoogle` will sweep them when the user next disconnects.
- The new `googlesuper` row exists.
- Both `last_synced_at` watermarks (gmail + calendar) continue to work via the new connection.

If you'd prefer eager cleanup, add to `register-integration`: after the `INSERT … ON CONFLICT` for `googlesuper`, also `DELETE FROM workspace_integrations WHERE workspace_id=$1 AND user_id=$2 AND toolkit_slug IN ('gmail','google-calendar')`. This is optional — leaving legacy rows is harmless because the ingest functions only check for `googlesuper`. Decide based on whether you want the "users see clean state" UX vs. a more invasive backend change.

- [ ] **Step 3: Commit if you took the optional eager-cleanup path**

```bash
git add backend/functions/register-integration/handler.ts
git commit -m "feat(register-integration): purge legacy gmail/calendar bindings on googlesuper bind"
```

Otherwise, skip.

---

## Task 9: Retire the old `gmail` toolkit configuration (cleanup)

**Files:** (operational only)

- [ ] **Step 1: Wait for confirmation that no production user has a legacy row**

Query:

```
mcp__butterbase__select_rows table: "workspace_integrations" where: "toolkit_slug IN ('gmail','google-calendar')"
```

Expected: empty result. If non-empty, message those users and wait — don't proceed until empty.

- [ ] **Step 2: Disable the old toolkit on the Butterbase app**

```
mcp__butterbase__manage_integrations action: "configure" toolkit_slug: "gmail" enabled: false
```

(There is no separate `google-calendar` `manage_integrations` config — it was set up live but not in `integrations.json`, per the original audit. If `list` shows it, disable it too.)

Expected: subsequent `bb.integrations.connect('gmail')` calls fail at the API level.

- [ ] **Step 3: No code change needed** — the codebase already only references `googlesuper`.

---

## Self-Review

**Spec coverage check:**
- ✅ Single OAuth replaces two → Task 1 + 6
- ✅ Backend functions accept the new toolkit → Tasks 3, 4, 5
- ✅ Per-service sync watermarks preserved → Tasks 3, 4 explicitly leave `integration_state.kind` alone; Task 5 maps one slug to two kinds
- ✅ Settings UI consolidates → Task 6
- ✅ Existing users handled → Task 8 + the legacy banner in Task 6 Step 3
- ✅ Smoke testing → Task 7
- ✅ Old toolkit retired → Task 9

**Placeholder scan:** Task 2 contains `<paste-id-from-task-1-step-2>` — this is intentional because the auth config ID is generated at runtime in Task 1.

**Type consistency:**
- `TOOLKIT_TO_STATE_KIND` (old, singular) → `TOOLKIT_TO_STATE_KINDS` (new, plural) — renamed deliberately to make the type change (one→many) visible at every call site. Task 5 updates both the declaration and the only consumer in the same step.
- `gmail` / `calendar` / `google` / `googleConnecting` variables in Settings.tsx — Task 6 introduces them and consumes them in the same task.
- `googlesuper` toolkit slug used consistently across Tasks 2, 3, 4, 5, 6.

**Risks worth flagging to the executing engineer:**
1. **Consent screen UX:** the `googlesuper` OAuth screen lists Drive/Docs/Sheets/etc. scopes even though we only call Gmail + Calendar actions. If users object during smoke testing, the fallback is to revert this plan and stay on two toolkits. Don't try to scope-narrow `googlesuper` — that defeats its purpose.
2. **Tool-name compatibility:** `googlesuper` exposes the same `GMAIL_FETCH_EMAILS`, `GMAIL_SEND_EMAIL`, `GOOGLECALENDAR_EVENTS_LIST` action names as the standalone toolkits, per Composio docs (verified 2026-06-04). If Composio renames them post-cutover, the ingest functions error visibly via `integration_state.last_error` — not silently.
3. The plan deliberately does **not** modify `invite-member` (which uses `GMAIL_SEND_EMAIL`). That function calls Composio by action name, not by toolkit slug, so it will route to whichever connection has Gmail scope — which is now `googlesuper`. Verify in Task 7 Step 3 by sending an invite after connect.
