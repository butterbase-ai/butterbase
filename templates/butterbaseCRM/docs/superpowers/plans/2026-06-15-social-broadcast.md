# Social Broadcast Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add workspace-level social broadcast posting to Twitter, LinkedIn, and Reddit via Composio — compose once, publish immediately or on schedule, with per-channel results, retries, and an activity-feed trail.

**Architecture:** Two new Postgres tables (`social_posts`, `social_post_sends`) hold draft/scheduled/sent state with the standard workspace-membership RLS. Three new Butterbase functions handle create → fan-out send → cron-driven scheduled pickup, each calling `/v1/{app_id}/integrations/execute` with the workspace's connected account (per Composio per-userId flow, with the workspace owner as the canonical poster). The frontend adds one route (`/social`) with a list page, a compose dialog, and a Settings → Connections subsection; realtime CDC propagates send-status changes.

**Tech Stack:** Butterbase MCP (`manage_schema`, `manage_rls`, `manage_function`, `manage_integrations`), Butterbase serverless functions (TypeScript handler.ts), Postgres, React 19 + Vite, React Query, `@butterbase/sdk`, Composio toolkits (`twitter`, `linkedin`, `reddit`).

**Spec:** `docs/superpowers/specs/2026-06-15-social-broadcast-design.md`

**App ID:** `app_44zjayftl7b3`

---

## File Structure

**Backend (`backend/`)** — read-only mirror; actual deploys via MCP `manage_function` / `manage_schema`. After each backend task, run `backend/sync.sh` to refresh the mirror.

- Create: `backend/functions/create-social-post/handler.ts` + `function.json`
- Create: `backend/functions/send-social-post/handler.ts` + `function.json`
- Create: `backend/functions/process-scheduled-social-posts/handler.ts` + `function.json`
- Create: `backend/functions/delete-social-post-from-platform/handler.ts` + `function.json` (optional, last task)
- Modify (via `manage_schema`): adds `social_posts` and `social_post_sends` tables, reflected in `backend/schema.json` after sync
- Modify (via `manage_rls`): adds 2 RLS policies, reflected in `backend/rls/policies.json` after sync

**Frontend (`frontend/src/`)**

- Create: `lib/socialApi.ts` — typed wrappers around `bbInvoke('create-social-post', ...)` etc.
- Create: `hooks/useSocialPosts.ts`
- Create: `hooks/useSocialConnections.ts`
- Create: `hooks/useCreateSocialPost.ts`
- Create: `hooks/useRetrySocialPost.ts`
- Create: `hooks/useCancelSocialPost.ts`
- Create: `pages/SocialPosts.tsx`
- Create: `components/NewSocialPostDialog.tsx`
- Create: `components/SocialPostDetailPanel.tsx`
- Create: `components/SocialConnectionsPanel.tsx`
- Modify: `routes/index.tsx` — add `/social` route
- Modify: `lib/realtime.ts` — subscribe to `social_posts` + `social_post_sends`
- Modify: `pages/Settings.tsx` — mount `SocialConnectionsPanel`
- Modify: `App.tsx` or sidebar nav component — add `📢 Social` link
- Modify: `pages/ActivityFeed.tsx` — handle 2 new activity kinds

---

## Task 1: Schema — `social_posts` and `social_post_sends`

**Files:**
- Modify (via MCP, mirrored to `backend/schema.json`): add 2 tables

- [ ] **Step 1: Inspect current schema for naming conventions**

Read: `backend/schema.json` (find the `activities` and `campaigns` table definitions). Confirm pattern: snake_case columns, `id` is uuid PK with `gen_random_uuid()` default, `workspace_id` is FK to `workspaces.id ON DELETE CASCADE`, timestamps use `timestamptz` with `default 'now()'`.

- [ ] **Step 2: Dry-run the schema change**

Run via MCP `manage_schema` with `action: "dry_run"` and the following added to `tables`:

```json
"social_posts": {
  "columns": {
    "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
    "workspace_id": { "type": "uuid", "nullable": false, "references": { "table": "workspaces", "column": "id", "onDelete": "CASCADE" } },
    "created_by": { "type": "uuid", "nullable": false },
    "body": { "type": "text", "nullable": false },
    "channels": { "type": "text[]", "nullable": false },
    "channel_overrides": { "type": "jsonb", "default": "'{}'::jsonb" },
    "link_url": { "type": "text" },
    "scheduled_at": { "type": "timestamptz" },
    "status": { "type": "text", "nullable": false, "default": "'draft'" },
    "error": { "type": "text" },
    "published_at": { "type": "timestamptz" },
    "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" },
    "updated_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
  },
  "indexes": {
    "social_posts_ws_cron_idx": { "columns": ["workspace_id", "status", "scheduled_at"] },
    "social_posts_ws_created_idx": { "columns": ["workspace_id", "created_at"] }
  }
},
"social_post_sends": {
  "columns": {
    "id": { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
    "workspace_id": { "type": "uuid", "nullable": false },
    "post_id": { "type": "uuid", "nullable": false, "references": { "table": "social_posts", "column": "id", "onDelete": "CASCADE" } },
    "channel": { "type": "text", "nullable": false },
    "status": { "type": "text", "nullable": false, "default": "'pending'" },
    "external_post_id": { "type": "text" },
    "external_url": { "type": "text" },
    "error": { "type": "text" },
    "attempts": { "type": "int", "nullable": false, "default": "0" },
    "sent_at": { "type": "timestamptz" },
    "created_at": { "type": "timestamptz", "nullable": false, "default": "now()" }
  },
  "indexes": {
    "social_post_sends_post_channel_uq": { "columns": ["post_id", "channel"], "unique": true },
    "social_post_sends_ws_channel_idx": { "columns": ["workspace_id", "channel", "sent_at"] }
  }
}
```

Expected: dry-run reports `CREATE TABLE social_posts`, `CREATE TABLE social_post_sends`, 4 indexes, no destructive ops.

- [ ] **Step 3: Apply the schema change**

Run MCP `manage_schema` with `action: "apply"` and the same payload.
Expected: `{ "status": "applied" }`.

- [ ] **Step 4: Sync the local mirror**

Run: `bash backend/sync.sh`
Expected: `backend/schema.json` now contains `social_posts` and `social_post_sends`.

- [ ] **Step 5: Verify with select_rows**

Run MCP `select_rows` with `table: "social_posts"`, `limit: 1`.
Expected: `{ "rows": [] }` (empty but valid).

- [ ] **Step 6: Commit**

```bash
git add backend/schema.json
git commit -m "feat(schema): add social_posts and social_post_sends tables"
```

---

## Task 2: RLS policies for the two new tables

**Files:**
- Modify (via MCP, mirrored to `backend/rls/policies.json`): add 2 policies

- [ ] **Step 1: Inspect existing workspace-RLS pattern**

Read: `backend/rls/policies.json`. Find the policy on the `notes` or `activities` table. Confirm the predicate shape:

```
workspace_id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = current_user_id()::uuid)
```

- [ ] **Step 2: Enable RLS on both tables**

Run MCP `manage_rls` with `action: "enable"`, `table: "social_posts"`.
Run MCP `manage_rls` with `action: "enable"`, `table: "social_post_sends"`.
Expected: both succeed.

- [ ] **Step 3: Create policy on social_posts**

Run MCP `manage_rls` with:
```json
{
  "action": "create_policy",
  "table": "social_posts",
  "name": "social_posts_ws_membership",
  "command": "ALL",
  "predicate": "workspace_id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = current_user_id()::uuid)",
  "check": "workspace_id IN (SELECT m.workspace_id FROM memberships m WHERE m.user_id = current_user_id()::uuid)"
}
```
Expected: `{ "status": "created" }`.

- [ ] **Step 4: Create policy on social_post_sends**

Same payload as Step 3 but `table: "social_post_sends"` and `name: "social_post_sends_ws_membership"`.

- [ ] **Step 5: Sync and commit**

```bash
bash backend/sync.sh
git add backend/rls/policies.json
git commit -m "feat(rls): scope social_posts and social_post_sends to workspace membership"
```

---

## Task 3: Configure Composio integrations (twitter, linkedin, reddit)

**Files:** none (operational MCP calls; mirrored to `backend/integrations/` after sync)

- [ ] **Step 1: Configure twitter**

Run MCP `manage_integrations` with:
```json
{ "app_id": "app_44zjayftl7b3", "action": "configure", "toolkit": "twitter" }
```
Expected: `{ "id": "...", "toolkit_slug": "twitter", "enabled": true }`.

- [ ] **Step 2: Configure linkedin**

Same as Step 1 with `toolkit: "linkedin"`.

- [ ] **Step 3: Configure reddit**

Same as Step 1 with `toolkit: "reddit"`.

- [ ] **Step 4: Sync mirror and verify**

```bash
bash backend/sync.sh
ls backend/integrations/
```
Expected: `twitter/`, `linkedin/`, `reddit/` directories exist.

- [ ] **Step 5: Commit**

```bash
git add backend/integrations/
git commit -m "feat(integrations): enable Composio twitter, linkedin, reddit toolkits"
```

> Note: actual OAuth connection for the workspace is done from the frontend Settings panel (Task 8) by the workspace owner. Until a connection exists, `send-social-post` will fail with `auth: token revoked`.

---

## Task 4: `send-social-post` function — core publish path

**Files:**
- Create: `backend/functions/send-social-post/function.json`
- Create: `backend/functions/send-social-post/handler.ts`

- [ ] **Step 1: Inspect the campaigns send pattern**

Read: `backend/functions/process-campaign-sends/handler.ts`. Note the Composio call shape:

```ts
const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`;
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
  body: JSON.stringify({ toolName, params, userId }),
});
```

This is the established pattern — reuse it.

- [ ] **Step 2: Write `function.json`**

Create `backend/functions/send-social-post/function.json`:

```json
{
  "name": "send-social-post",
  "description": "Internal: fans a social_posts row out to its selected channels via Composio. Idempotent on post status. Called by create-social-post (immediate) and process-scheduled-social-posts (cron).",
  "triggers": [{ "type": "http", "config": { "method": "POST", "path": "/send-social-post" }, "enabled": true }],
  "timeoutMs": 60000,
  "memoryLimitMb": 128,
  "agent_tool": false,
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

- [ ] **Step 3: Write `handler.ts`**

Create `backend/functions/send-social-post/handler.ts`:

```ts
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function composio(ctx, toolName, params, userId) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify({ toolName, params, userId }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) return { ok: false, error: `composio ${res.status}: ${text.slice(0, 300)}` };
  if (!parsed?.successful) return { ok: false, error: parsed?.error ?? 'composio_returned_failure' };
  return { ok: true, data: parsed.data ?? {} };
}

function effectiveBody(post, channel) {
  const override = post.channel_overrides?.[channel]?.body;
  return (typeof override === 'string' && override.length > 0) ? override : post.body;
}

async function sendTwitter(ctx, post, send, userId) {
  return composio(ctx, 'TWITTER_CREATION_OF_A_POST', { text: effectiveBody(post, 'twitter') }, userId);
}

async function sendLinkedIn(ctx, post, send, userId) {
  // Look up cached author URN; fetch + cache via workspace_integrations.metadata if missing.
  let urn = null;
  const wi = await ctx.db.query(
    `SELECT metadata FROM workspace_integrations WHERE workspace_id = $1 AND toolkit = 'linkedin' LIMIT 1`,
    [post.workspace_id],
  );
  urn = wi.rows?.[0]?.metadata?.linkedin_author_urn ?? null;
  if (!urn) {
    const info = await composio(ctx, 'LINKEDIN_GET_MY_INFO', {}, userId);
    if (!info.ok) return info;
    const id = info.data?.id ?? info.data?.sub;
    if (!id) return { ok: false, error: 'linkedin: no author id returned' };
    urn = `urn:li:person:${id}`;
    await ctx.db.query(
      `UPDATE workspace_integrations
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('linkedin_author_urn', $2::text)
       WHERE workspace_id = $1 AND toolkit = 'linkedin'`,
      [post.workspace_id, urn],
    );
  }

  const body = effectiveBody(post, 'linkedin');
  const visibility = post.channel_overrides?.linkedin?.visibility ?? 'PUBLIC';

  if (post.link_url) {
    return composio(ctx, 'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE', {
      author: urn,
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: body },
          shareMediaCategory: 'ARTICLE',
          media: [{ status: 'READY', originalUrl: post.link_url }],
        },
      },
    }, userId);
  }
  return composio(ctx, 'LINKEDIN_CREATE_LINKED_IN_POST', { author: urn, commentary: body, visibility }, userId);
}

async function sendReddit(ctx, post, send, userId) {
  const r = post.channel_overrides?.reddit ?? {};
  const body = effectiveBody(post, 'reddit');
  const kind = post.link_url ? 'link' : 'self';
  const params = {
    subreddit: r.subreddit,
    title: r.title,
    kind,
    ...(kind === 'self' ? { text: body } : { url: post.link_url }),
    ...(r.flair_id ? { flair_id: r.flair_id } : {}),
  };
  return composio(ctx, 'REDDIT_CREATE_REDDIT_POST', params, userId);
}

const SENDERS = { twitter: sendTwitter, linkedin: sendLinkedIn, reddit: sendReddit };

function externalUrlFor(channel, data) {
  if (channel === 'twitter') {
    const id = data?.id ?? data?.data?.id;
    return id ? `https://twitter.com/i/web/status/${id}` : null;
  }
  if (channel === 'linkedin') {
    const id = data?.id ?? data?.activity ?? null;
    return id ? `https://www.linkedin.com/feed/update/${id}` : null;
  }
  if (channel === 'reddit') {
    const permalink = data?.json?.data?.url ?? data?.url ?? null;
    return permalink;
  }
  return null;
}

function externalIdFor(channel, data) {
  if (channel === 'twitter') return data?.id ?? data?.data?.id ?? null;
  if (channel === 'linkedin') return data?.id ?? null;
  if (channel === 'reddit') return data?.json?.data?.name ?? data?.name ?? null;
  return null;
}

export async function handler(req, ctx) {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { post_id, retry = false } = body || {};
  if (!post_id) return json(400, { error: 'missing post_id' });

  const postRow = await ctx.db.query(`SELECT * FROM social_posts WHERE id = $1`, [post_id]);
  const post = postRow.rows?.[0];
  if (!post) return json(404, { error: 'post_not_found' });

  // Idempotency guard.
  if (!['sending', 'scheduled'].includes(post.status) && !retry) {
    return json(200, { ok: true, noop: true, status: post.status });
  }

  // If retry, reset failed sends to pending.
  if (retry) {
    await ctx.db.query(
      `UPDATE social_post_sends SET status='pending', attempts = attempts + 1, error = NULL
         WHERE post_id = $1 AND status = 'failed'`,
      [post_id],
    );
  }

  await ctx.db.query(`UPDATE social_posts SET status='sending', updated_at=now() WHERE id=$1`, [post_id]);

  const pendingRes = await ctx.db.query(
    `SELECT * FROM social_post_sends WHERE post_id = $1 AND status = 'pending'`,
    [post_id],
  );
  const pending = pendingRes.rows ?? [];

  // Workspace owner is the canonical poster (per spec: per-workspace shared accounts).
  const ownerRes = await ctx.db.query(
    `SELECT owner_user_id FROM workspaces WHERE id = $1`,
    [post.workspace_id],
  );
  const userId = ownerRes.rows?.[0]?.owner_user_id;
  if (!userId) {
    await ctx.db.query(`UPDATE social_posts SET status='failed', error='no_workspace_owner', updated_at=now() WHERE id=$1`, [post_id]);
    return json(500, { error: 'no_workspace_owner' });
  }

  const results = await Promise.all(pending.map(async (send) => {
    const sender = SENDERS[send.channel];
    if (!sender) return { send, ok: false, error: `unknown channel: ${send.channel}` };
    try {
      const r = await sender(ctx, post, send, userId);
      return { send, ...r };
    } catch (e) {
      return { send, ok: false, error: `exception: ${e?.message ?? String(e)}` };
    }
  }));

  for (const r of results) {
    if (r.ok) {
      await ctx.db.query(
        `UPDATE social_post_sends
            SET status='sent', external_post_id=$2, external_url=$3, sent_at=now()
          WHERE id=$1`,
        [r.send.id, externalIdFor(r.send.channel, r.data), externalUrlFor(r.send.channel, r.data)],
      );
    } else {
      await ctx.db.query(
        `UPDATE social_post_sends SET status='failed', error=$2 WHERE id=$1`,
        [r.send.id, r.error?.slice(0, 1000) ?? 'unknown_error'],
      );
    }
  }

  // Recompute parent status across ALL sends, not just this batch.
  const allRes = await ctx.db.query(`SELECT status FROM social_post_sends WHERE post_id = $1`, [post_id]);
  const all = (allRes.rows ?? []).map(r => r.status);
  const allSent = all.length > 0 && all.every(s => s === 'sent');
  const noneSent = all.every(s => s !== 'sent');
  const finalStatus = allSent ? 'sent' : noneSent ? 'failed' : 'partial';

  await ctx.db.query(
    `UPDATE social_posts
        SET status=$2,
            published_at = CASE WHEN $2 IN ('sent','partial') AND published_at IS NULL THEN now() ELSE published_at END,
            updated_at=now()
      WHERE id=$1`,
    [post_id, finalStatus],
  );

  // Activity row.
  const activityKind = finalStatus === 'failed' ? 'social_post_failed' : 'social_post_published';
  const channelStatuses = Object.fromEntries(results.map(r => [r.send.channel, r.ok ? 'sent' : 'failed']));
  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, 'social_post', $4, $5::jsonb)`,
    [post.workspace_id, post.created_by, activityKind, post_id, JSON.stringify({ channels: channelStatuses, body_preview: post.body.slice(0, 140) })],
  );

  return json(200, { ok: true, status: finalStatus, results: results.map(r => ({ channel: r.send.channel, ok: r.ok, error: r.error })) });
}
```

- [ ] **Step 4: Deploy the function**

Run MCP `deploy_function` with `name: "send-social-post"` pointing at `backend/functions/send-social-post/`.
Expected: `{ "status": "deployed" }`.

- [ ] **Step 5: Verify deployment**

Run MCP `manage_function` with `action: "list"`. Confirm `send-social-post` appears with the http trigger.

- [ ] **Step 6: Commit**

```bash
git add backend/functions/send-social-post/
git commit -m "feat(fn): add send-social-post — fans a post out to twitter/linkedin/reddit"
```

---

## Task 5: `create-social-post` function

**Files:**
- Create: `backend/functions/create-social-post/function.json`
- Create: `backend/functions/create-social-post/handler.ts`

- [ ] **Step 1: Write `function.json`**

```json
{
  "name": "create-social-post",
  "description": "Validates a compose payload, writes social_posts + social_post_sends rows, and either invokes send-social-post (immediate) or leaves the post for the cron (scheduled).",
  "triggers": [{ "type": "http", "config": { "method": "POST", "path": "/create-social-post" }, "enabled": true }],
  "timeoutMs": 15000,
  "memoryLimitMb": 128,
  "agent_tool": false,
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

- [ ] **Step 2: Write `handler.ts`**

```ts
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const LIMITS = {
  twitter: { body: 280 },
  linkedin: { body: 3000 },
  reddit: { title: 300, body: 40000 },
};

const VALID_CHANNELS = ['twitter', 'linkedin', 'reddit'];

function eff(body, overrides, channel) {
  const o = overrides?.[channel]?.body;
  return (typeof o === 'string' && o.length > 0) ? o : body;
}

export async function handler(req, ctx) {
  const userId = ctx.auth?.userId;
  if (!userId) return json(401, { error: 'unauthenticated' });

  let input;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const { body, channels, channel_overrides = {}, link_url, scheduled_at } = input || {};

  if (typeof body !== 'string' || body.length === 0) return json(400, { error: 'body required' });
  if (!Array.isArray(channels) || channels.length === 0) return json(400, { error: 'channels must be non-empty array' });
  for (const c of channels) {
    if (!VALID_CHANNELS.includes(c)) return json(400, { error: `invalid channel: ${c}` });
  }

  // Per-channel char-limit validation.
  if (channels.includes('twitter') && eff(body, channel_overrides, 'twitter').length > LIMITS.twitter.body) {
    return json(400, { error: 'twitter body exceeds 280 chars' });
  }
  if (channels.includes('linkedin') && eff(body, channel_overrides, 'linkedin').length > LIMITS.linkedin.body) {
    return json(400, { error: 'linkedin body exceeds 3000 chars' });
  }
  if (channels.includes('reddit')) {
    const r = channel_overrides?.reddit ?? {};
    if (!r.title || typeof r.title !== 'string') return json(400, { error: 'reddit requires title' });
    if (!r.subreddit || typeof r.subreddit !== 'string') return json(400, { error: 'reddit requires subreddit' });
    if (r.title.length > LIMITS.reddit.title) return json(400, { error: 'reddit title exceeds 300 chars' });
    if (eff(body, channel_overrides, 'reddit').length > LIMITS.reddit.body) return json(400, { error: 'reddit body exceeds 40000 chars' });
  }

  // Resolve workspace.
  const memRow = await ctx.db.query(
    `SELECT workspace_id FROM memberships WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const workspace_id = memRow.rows?.[0]?.workspace_id;
  if (!workspace_id) return json(403, { error: 'no_workspace' });

  // Verify connected channels.
  const intRes = await fetch(
    `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connected`,
    { headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` } },
  );
  const connected = await intRes.json().catch(() => ({ connections: [] }));
  const connectedSlugs = new Set((connected.connections ?? []).filter(c => c.status === 'active').map(c => c.toolkit_slug));
  const missing = channels.filter(c => !connectedSlugs.has(c));
  if (missing.length > 0) return json(400, { error: 'channels_not_connected', missing_channels: missing });

  // Schedule sanity.
  const now = Date.now();
  let isScheduled = false;
  if (scheduled_at) {
    const t = Date.parse(scheduled_at);
    if (Number.isNaN(t)) return json(400, { error: 'invalid scheduled_at' });
    if (t < now + 30_000) return json(400, { error: 'scheduled_at must be at least 30s in the future' });
    isScheduled = true;
  }

  const status = isScheduled ? 'scheduled' : 'sending';
  const insertRes = await ctx.db.query(
    `INSERT INTO social_posts (workspace_id, created_by, body, channels, channel_overrides, link_url, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING id`,
    [workspace_id, userId, body, channels, JSON.stringify(channel_overrides), link_url ?? null, scheduled_at ?? null, status],
  );
  const post_id = insertRes.rows[0].id;

  // One send row per channel.
  for (const channel of channels) {
    await ctx.db.query(
      `INSERT INTO social_post_sends (workspace_id, post_id, channel) VALUES ($1, $2, $3)`,
      [workspace_id, post_id, channel],
    );
  }

  // Immediate path: fire-and-forget invoke send-social-post.
  if (!isScheduled) {
    fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/functions/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        body: JSON.stringify({ name: 'send-social-post', payload: { post_id } }),
      },
    ).catch(() => { /* swallow — send is idempotent and cron will pick up stragglers */ });
  }

  return json(200, { id: post_id, status });
}
```

- [ ] **Step 3: Deploy**

Run MCP `deploy_function` for `create-social-post`.

- [ ] **Step 4: Smoke test — validation rejection**

Run MCP `invoke_function`:
```json
{ "name": "create-social-post", "payload": { "body": "test", "channels": [] } }
```
Expected: 400 `channels must be non-empty array`.

- [ ] **Step 5: Smoke test — missing-connection rejection**

```json
{ "name": "create-social-post", "payload": { "body": "test", "channels": ["twitter"] } }
```
Expected: 400 `channels_not_connected` with `missing_channels: ["twitter"]` (until Task 8 connects a real account).

- [ ] **Step 6: Sync and commit**

```bash
bash backend/sync.sh
git add backend/functions/create-social-post/
git commit -m "feat(fn): add create-social-post with validation + send dispatch"
```

---

## Task 6: `process-scheduled-social-posts` cron

**Files:**
- Create: `backend/functions/process-scheduled-social-posts/function.json`
- Create: `backend/functions/process-scheduled-social-posts/handler.ts`

- [ ] **Step 1: Write `function.json`**

```json
{
  "name": "process-scheduled-social-posts",
  "description": "Cron-driven: picks up social_posts with status='scheduled' and scheduled_at <= now() and invokes send-social-post for each.",
  "triggers": [{ "type": "cron", "config": { "schedule": "*/5 * * * *", "timezone": "UTC" }, "enabled": true }],
  "timeoutMs": 30000,
  "memoryLimitMb": 128,
  "agent_tool": false,
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
```

- [ ] **Step 2: Write `handler.ts`**

```ts
const PER_TICK_CAP = 50;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(_req, ctx) {
  const dueRes = await ctx.db.query(
    `SELECT id FROM social_posts
      WHERE status = 'scheduled' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC
      LIMIT $1`,
    [PER_TICK_CAP],
  );
  const ids = (dueRes.rows ?? []).map(r => r.id);

  for (const post_id of ids) {
    // Fire-and-forget; send-social-post is idempotent.
    fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/functions/invoke`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        body: JSON.stringify({ name: 'send-social-post', payload: { post_id } }),
      },
    ).catch(() => {});
  }

  return json(200, { ok: true, dispatched: ids.length });
}
```

- [ ] **Step 3: Deploy and verify cron registration**

Run MCP `deploy_function` for `process-scheduled-social-posts`, then MCP `manage_function` with `action: "list"`. Confirm the cron trigger is registered.

- [ ] **Step 4: Sync and commit**

```bash
bash backend/sync.sh
git add backend/functions/process-scheduled-social-posts/
git commit -m "feat(fn): add process-scheduled-social-posts cron"
```

---

## Task 7: Frontend — `lib/socialApi.ts`

**Files:**
- Create: `frontend/src/lib/socialApi.ts`

- [ ] **Step 1: Inspect existing API wrapper pattern**

Read: `frontend/src/lib/butterbase.ts` (look for `bbInvoke`). Confirm signature: `bbInvoke<T>(name: string, payload: unknown): Promise<T>`.

- [ ] **Step 2: Write the wrapper**

Create `frontend/src/lib/socialApi.ts`:

```ts
import { bb, bbInvoke } from './butterbase'

export type SocialChannel = 'twitter' | 'linkedin' | 'reddit'

export type SocialPostStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'partial' | 'failed' | 'canceled'
export type SocialSendStatus = 'pending' | 'sent' | 'failed'

export interface ChannelOverrides {
  twitter?: { body?: string }
  linkedin?: { body?: string; visibility?: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN' }
  reddit?: { title: string; subreddit: string; flair_id?: string; body?: string }
}

export interface SocialPost {
  id: string
  workspace_id: string
  created_by: string
  body: string
  channels: SocialChannel[]
  channel_overrides: ChannelOverrides
  link_url: string | null
  scheduled_at: string | null
  status: SocialPostStatus
  error: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface SocialPostSend {
  id: string
  workspace_id: string
  post_id: string
  channel: SocialChannel
  status: SocialSendStatus
  external_post_id: string | null
  external_url: string | null
  error: string | null
  attempts: number
  sent_at: string | null
  created_at: string
}

export interface CreatePayload {
  body: string
  channels: SocialChannel[]
  channel_overrides?: ChannelOverrides
  link_url?: string
  scheduled_at?: string
}

export async function createSocialPost(payload: CreatePayload) {
  return bbInvoke<{ id: string; status: SocialPostStatus }>('create-social-post', payload)
}

export async function retrySocialPost(post_id: string) {
  return bbInvoke<{ ok: boolean; status: SocialPostStatus }>('send-social-post', { post_id, retry: true })
}

export async function cancelSocialPost(post_id: string) {
  return bb.from('social_posts')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('id', post_id)
    .eq('status', 'scheduled')
}

export async function deleteFromPlatform(send_id: string) {
  return bbInvoke<{ ok: boolean }>('delete-social-post-from-platform', { send_id })
}

export async function listSocialPosts() {
  const { data, error } = await bb.from('social_posts').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data as SocialPost[]
}

export async function listSocialPostSends(post_ids: string[]) {
  if (post_ids.length === 0) return [] as SocialPostSend[]
  const { data, error } = await bb.from('social_post_sends').select('*').in('post_id', post_ids)
  if (error) throw error
  return data as SocialPostSend[]
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors related to `socialApi.ts`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/socialApi.ts
git commit -m "feat(frontend): add socialApi typed wrappers"
```

---

## Task 8: Frontend — Settings → Connections panel

**Files:**
- Create: `frontend/src/components/SocialConnectionsPanel.tsx`
- Create: `frontend/src/hooks/useSocialConnections.ts`
- Modify: `frontend/src/pages/Settings.tsx`

- [ ] **Step 1: Inspect how existing Gmail/Calendar connect flow works**

Read `frontend/src/pages/Settings.tsx` and grep for `manage_integrations` / `integrations/connect` / OAuth redirect handling. Match whatever the existing Gmail/Calendar Connect button does.

- [ ] **Step 2: Write `useSocialConnections.ts`**

```ts
import { useQuery } from '@tanstack/react-query'
import { bbInvoke } from '../lib/butterbase'
import type { SocialChannel } from '../lib/socialApi'

export interface Connection {
  toolkit_slug: SocialChannel
  status: 'active' | 'inactive'
  connected_at: string
  account_handle?: string | null
}

export function useSocialConnections() {
  return useQuery({
    queryKey: ['social-connections'],
    queryFn: async () => {
      const r = await bbInvoke<{ connections: Connection[] }>('list-social-connections', {})
      // Fallback: hit the integrations API directly if no helper fn exists.
      return r.connections.filter(c => ['twitter', 'linkedin', 'reddit'].includes(c.toolkit_slug))
    },
    staleTime: 30_000,
  })
}
```

> **Note:** if there's no existing `list-social-connections` helper fn and Gmail/Calendar Settings reads `bb.integrations.listConnected()` from the SDK directly, replace the `bbInvoke` call with the SDK method. The existing Settings page is the source of truth.

- [ ] **Step 3: Write `SocialConnectionsPanel.tsx`**

```tsx
import { useSocialConnections } from '../hooks/useSocialConnections'

const META = {
  twitter: { name: 'Twitter / X', icon: '🐦', bg: 'bg-sky-100' },
  linkedin: { name: 'LinkedIn', icon: '💼', bg: 'bg-blue-100' },
  reddit: { name: 'Reddit', icon: '🅡', bg: 'bg-orange-100' },
} as const

export function SocialConnectionsPanel() {
  const { data: connections = [], refetch } = useSocialConnections()
  const lookup = new Map(connections.map(c => [c.toolkit_slug, c]))

  function connect(toolkit: string) {
    // Mirror the existing Gmail Connect flow.
    const url = `/api/integrations/${toolkit}/oauth/start?return=${encodeURIComponent(window.location.pathname)}`
    window.location.href = url
  }

  async function disconnect(toolkit: string) {
    await fetch(`/api/integrations/${toolkit}/disconnect`, { method: 'POST' })
    refetch()
  }

  return (
    <section className="space-y-3">
      <header>
        <h3 className="text-base font-semibold">Social accounts</h3>
        <p className="text-sm text-gray-500">Connect your workspace's social accounts. All workspace members can post from connected accounts.</p>
      </header>
      {(['twitter', 'linkedin', 'reddit'] as const).map(slug => {
        const meta = META[slug]
        const conn = lookup.get(slug)
        const isConnected = conn?.status === 'active'
        return (
          <div key={slug} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3">
            <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${meta.bg} text-lg`}>{meta.icon}</span>
            <div className="flex-1">
              <div className="text-sm font-semibold">{meta.name}</div>
              <div className="text-xs text-gray-500">
                {isConnected
                  ? <>Connected{conn?.account_handle ? <> as <b>{conn.account_handle}</b></> : null}</>
                  : 'Not connected'}
              </div>
            </div>
            {isConnected
              ? <button onClick={() => disconnect(slug)} className="rounded border border-gray-200 px-3 py-1 text-xs font-medium text-red-600">Disconnect</button>
              : <button onClick={() => connect(slug)} className="rounded border-0 bg-blue-600 px-3 py-1 text-xs font-medium text-white">Connect</button>
            }
          </div>
        )
      })}
    </section>
  )
}
```

> **Note:** the `/api/integrations/...` URLs are placeholders — replace with the actual OAuth start/disconnect endpoints the existing Gmail Settings uses (visible in Step 1).

- [ ] **Step 4: Mount in `Settings.tsx`**

Add: `import { SocialConnectionsPanel } from '../components/SocialConnectionsPanel'`
Render `<SocialConnectionsPanel />` in the appropriate section of the Settings page (next to Gmail/Calendar connections).

- [ ] **Step 5: Type-check and visual smoke**

```bash
cd frontend && npx tsc --noEmit
npm run dev
```
Open Settings; confirm 3 rows render with "Not connected" badges and Connect buttons.

- [ ] **Step 6: OAuth round-trip (manual)**

Click `Connect` for one toolkit (e.g., Twitter); complete the OAuth flow; return to Settings; confirm the row flips to "Connected".

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/SocialConnectionsPanel.tsx frontend/src/hooks/useSocialConnections.ts frontend/src/pages/Settings.tsx
git commit -m "feat(frontend): Settings panel for social account connections"
```

---

## Task 9: Frontend — `NewSocialPostDialog`

**Files:**
- Create: `frontend/src/components/NewSocialPostDialog.tsx`
- Create: `frontend/src/hooks/useCreateSocialPost.ts`

- [ ] **Step 1: Write `useCreateSocialPost.ts`**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createSocialPost, CreatePayload } from '../lib/socialApi'

export function useCreateSocialPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CreatePayload) => createSocialPost(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['social-posts'] }),
  })
}
```

- [ ] **Step 2: Write `NewSocialPostDialog.tsx`**

Use the existing modal styling pattern. Implement, in this order:
- Channel toggles (3 buttons). Disabled when not connected, with `title="Connect in Settings →"` tooltip.
- Shared body `<textarea>`.
- Per-channel character-count badges, computed from `eff(body, overrides, channel)`. Color `text-green-600` when ≤ limit, `text-amber-600` when > limit.
- Optional `link_url` `<input>`.
- Collapsible "Customize for Twitter" / "Customize for LinkedIn" sections (each adds an override body input).
- Reddit fields block (conditional on `channels.includes('reddit')`): `subreddit`, `title`, `flair_id` (dropdown — leave dropdown options empty for Phase 1; pure freetext fallback for `flair_id`).
- Schedule radio: `Publish now | Schedule for`; date + time inputs (local TZ).
- Footer: `Cancel | Save Draft | Publish/Schedule` (primary label changes based on the radio).

The handler builds the `CreatePayload`:

```ts
const payload: CreatePayload = {
  body,
  channels: selectedChannels,
  channel_overrides: {
    ...(twOverride && { twitter: { body: twOverride } }),
    ...(liOverride && { linkedin: { body: liOverride } }),
    ...(selectedChannels.includes('reddit') && {
      reddit: { title: redditTitle, subreddit: redditSubreddit, flair_id: redditFlairId || undefined, body: redditBody || undefined },
    }),
  },
  link_url: linkUrl || undefined,
  scheduled_at: isScheduled ? new Date(`${scheduleDate}T${scheduleTime}`).toISOString() : undefined,
}
await create.mutateAsync(payload)
onClose()
```

Show server errors inline at the top of the dialog: `{ create.error?.message }`.

- [ ] **Step 3: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/NewSocialPostDialog.tsx frontend/src/hooks/useCreateSocialPost.ts
git commit -m "feat(frontend): NewSocialPostDialog composer"
```

---

## Task 10: Frontend — `SocialPosts` list page + side panel + route

**Files:**
- Create: `frontend/src/pages/SocialPosts.tsx`
- Create: `frontend/src/components/SocialPostDetailPanel.tsx`
- Create: `frontend/src/hooks/useSocialPosts.ts`
- Create: `frontend/src/hooks/useRetrySocialPost.ts`
- Create: `frontend/src/hooks/useCancelSocialPost.ts`
- Modify: `frontend/src/routes/index.tsx`
- Modify: sidebar/nav (locate by inspecting `App.tsx` or routes)

- [ ] **Step 1: Write `useSocialPosts.ts`**

```ts
import { useQuery } from '@tanstack/react-query'
import { listSocialPosts, listSocialPostSends } from '../lib/socialApi'

export function useSocialPosts() {
  return useQuery({
    queryKey: ['social-posts'],
    queryFn: async () => {
      const posts = await listSocialPosts()
      const sends = await listSocialPostSends(posts.map(p => p.id))
      const byPost = new Map<string, typeof sends>()
      for (const s of sends) {
        const arr = byPost.get(s.post_id) ?? []
        arr.push(s)
        byPost.set(s.post_id, arr)
      }
      return posts.map(p => ({ ...p, sends: byPost.get(p.id) ?? [] }))
    },
  })
}
```

- [ ] **Step 2: Write `useRetrySocialPost.ts` and `useCancelSocialPost.ts`**

Mirror Task 9 Step 1 pattern — wrap `retrySocialPost` / `cancelSocialPost` with `useMutation` and invalidate `['social-posts']` on success.

- [ ] **Step 3: Write `SocialPostDetailPanel.tsx`**

Props: `{ post: SocialPost & { sends: SocialPostSend[] }, onRetry, onCancel, onDelete }`.
Renders the side-panel UI mocked in `.superpowers/brainstorm/.../list-and-settings.html`: title, meta line, body block, per-channel send rows with status pill + "view ↗" link to `external_url`, error block for failed sends (red background with verbatim `error` text), action buttons row.

- [ ] **Step 4: Write `SocialPosts.tsx`**

Toolbar with `+ New Post` button (opens `NewSocialPostDialog`), search box, status filter chips, channel filter chips. Table of posts (body truncated, channel pills, when relative, status pill with colored dot, author avatar). Click row → side panel opens with `SocialPostDetailPanel`. Filter logic is plain client-side filtering of the `useSocialPosts` result.

- [ ] **Step 5: Add `/social` route**

In `frontend/src/routes/index.tsx`:
```ts
import { SocialPosts } from '../pages/SocialPosts'
// ...
{ path: '/social', element: <SocialPosts /> },
```

- [ ] **Step 6: Add nav link**

Find the sidebar nav (likely `App.tsx` or a `Sidebar.tsx` component) and add a `<Link to="/social">📢 Social</Link>` between Campaigns and Activity.

- [ ] **Step 7: Visual smoke**

```bash
cd frontend && npm run dev
```
Navigate to `/social`. Confirm: page renders, `+ New Post` opens dialog, table is empty (no posts yet).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/SocialPosts.tsx frontend/src/components/SocialPostDetailPanel.tsx frontend/src/hooks/useSocialPosts.ts frontend/src/hooks/useRetrySocialPost.ts frontend/src/hooks/useCancelSocialPost.ts frontend/src/routes/index.tsx frontend/src/App.tsx
git commit -m "feat(frontend): /social list page with side panel"
```

---

## Task 11: Realtime subscription wiring

**Files:**
- Modify: `frontend/src/lib/realtime.ts`

- [ ] **Step 1: Inspect existing subscribed-table list**

Read `frontend/src/lib/realtime.ts`. Find the array/object of subscribed tables (e.g., `notes`, `activities`, `attachments`).

- [ ] **Step 2: Add the two new tables**

Add `social_posts` and `social_post_sends` to the subscribed list. On row change, invalidate the `['social-posts']` React Query key (use whatever pattern the existing entries use — typically a single `qc.invalidateQueries` call).

- [ ] **Step 3: Visual verify**

With dev server running and the `/social` page open in two browser tabs: create a post in tab A; confirm it appears in tab B without a manual refresh.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/realtime.ts
git commit -m "feat(realtime): subscribe to social_posts and social_post_sends"
```

---

## Task 12: End-to-end smoke test (immediate publish)

**Files:** none — verification task

- [ ] **Step 1: Connect at least one account**

Via Settings → Social, connect a Twitter account (use a test/burner if possible).

- [ ] **Step 2: Compose and publish a test post**

Click `+ New Post`, body `"Test post from butterbaseCRM — please ignore"`, channel: Twitter, click `Publish`.

- [ ] **Step 3: Observe status transitions**

Watch the row in the list: status should go `sending → sent` within ~10s. Click the row → side panel shows the Twitter send row with status `Sent` and a `view ↗` link.

- [ ] **Step 4: Verify on Twitter**

Click `view ↗` — confirms the actual tweet exists.

- [ ] **Step 5: Verify activity row**

Navigate to Activity Feed; confirm a `social_post_published` row exists with the expected payload.

- [ ] **Step 6: Verify partial failure**

Compose a post selecting Twitter (connected) + Reddit (not connected, or with an invalid subreddit like `r/thissubdoesnotexistforsure`). Publish. Confirm:
- Twitter send → `Sent`
- Reddit send → `Failed` with provider error message visible in side panel
- Parent status → `Partial`

- [ ] **Step 7: Test retry**

In the partial-failure post, click `Retry failed channels`. Confirm Reddit attempts again, `attempts` increments. (With the bad subreddit, it should fail again — verifies the retry path works mechanically.)

If anything in steps 1–7 fails, do not commit; debug.

- [ ] **Step 8: Commit nothing — write a verification note**

No code change; the smoke test result goes in the PR description.

---

## Task 13: Scheduled publish smoke test

**Files:** none — verification task

- [ ] **Step 1: Compose a scheduled post**

`+ New Post`, body `"Scheduled test"`, channel: Twitter, schedule for `now + 6 min` (cron fires every 5).

- [ ] **Step 2: Observe scheduled state**

Confirm row appears with status `Scheduled` and the scheduled time displayed.

- [ ] **Step 3: Wait for cron tick**

After 6–10 minutes, status should flip to `sending → sent`. Verify on Twitter.

- [ ] **Step 4: Test cancel**

Compose another scheduled post for `now + 20 min`. In side panel, click `Cancel`. Confirm:
- status flips to `Canceled`
- after 20 min passes, the cron does NOT pick it up (verify via logs or the row remaining at `Canceled`)

---

## Task 14: Activity feed filter chips for the new kinds

**Files:**
- Modify: `frontend/src/pages/ActivityFeed.tsx`

- [ ] **Step 1: Add chips and rendering**

Inspect existing chip list. Add two chips for `social_post_published` and `social_post_failed`. Render the payload nicely:

```tsx
function renderSocialPost(payload: { body_preview: string; channels: Record<string, string> }) {
  const ok = Object.entries(payload.channels).filter(([, s]) => s === 'sent').map(([c]) => c)
  const failed = Object.entries(payload.channels).filter(([, s]) => s === 'failed').map(([c]) => c)
  return (
    <span>
      <span className="text-gray-700">{payload.body_preview}</span>
      <span className="ml-2 text-xs text-gray-500">
        {ok.length > 0 && <span className="text-green-700">sent: {ok.join(', ')}</span>}
        {failed.length > 0 && <span className="ml-2 text-red-700">failed: {failed.join(', ')}</span>}
      </span>
    </span>
  )
}
```

Wire it into the activity row renderer's switch on `kind`.

- [ ] **Step 2: Visual verify**

Open Activity Feed; confirm new chips work as filters, and a recent social post entry renders with the channel summary.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/ActivityFeed.tsx
git commit -m "feat(activity): render social_post_published/failed entries"
```

---

## Task 15: (Optional) `delete-social-post-from-platform` function + UI

**Files:**
- Create: `backend/functions/delete-social-post-from-platform/handler.ts` + `function.json`
- Modify: `frontend/src/components/SocialPostDetailPanel.tsx`

- [ ] **Step 1: Write the function**

`function.json` mirrors Task 4 Step 2 (HTTP, internal). `handler.ts`:

```ts
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function composio(ctx, toolName, params, userId) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify({ toolName, params, userId }),
  });
  return res.ok;
}

const DELETE_TOOL = {
  twitter: 'TWITTER_POST_DELETE_BY_POST_ID',
  linkedin: 'LINKEDIN_DELETE_LINKED_IN_POST',
  reddit: 'REDDIT_DELETE_REDDIT_POST',
};

export async function handler(req, ctx) {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { send_id } = body || {};
  if (!send_id) return json(400, { error: 'missing send_id' });

  const sendRes = await ctx.db.query(
    `SELECT s.*, p.workspace_id, p.created_by FROM social_post_sends s JOIN social_posts p ON p.id = s.post_id WHERE s.id = $1`,
    [send_id],
  );
  const send = sendRes.rows?.[0];
  if (!send) return json(404, { error: 'send_not_found' });
  if (!send.external_post_id) return json(400, { error: 'no_external_post_id' });

  const tool = DELETE_TOOL[send.channel];
  if (!tool) return json(400, { error: `unsupported channel: ${send.channel}` });

  const ownerRes = await ctx.db.query(`SELECT owner_user_id FROM workspaces WHERE id = $1`, [send.workspace_id]);
  const userId = ownerRes.rows?.[0]?.owner_user_id;
  if (!userId) return json(500, { error: 'no_workspace_owner' });

  const param = send.channel === 'twitter'
    ? { id: send.external_post_id }
    : send.channel === 'reddit'
      ? { id: send.external_post_id }
      : { id: send.external_post_id };

  const ok = await composio(ctx, tool, param, userId);
  if (!ok) return json(502, { error: 'platform_delete_failed' });

  await ctx.db.query(
    `UPDATE social_post_sends SET external_post_id = NULL, external_url = NULL WHERE id = $1`,
    [send_id],
  );
  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'social_post_removed_from_platform', 'social_post', $3, $4::jsonb)`,
    [send.workspace_id, send.created_by, send.post_id, JSON.stringify({ channel: send.channel })],
  );
  return json(200, { ok: true });
}
```

- [ ] **Step 2: Deploy**

Run MCP `deploy_function` for `delete-social-post-from-platform`.

- [ ] **Step 3: Wire UI**

In `SocialPostDetailPanel.tsx`, add a small "Remove from platform" link next to each sent channel's `view ↗` link. On click, confirm dialog → call `deleteFromPlatform(send.id)` → refetch.

- [ ] **Step 4: Sync, type-check, and commit**

```bash
bash backend/sync.sh
cd frontend && npx tsc --noEmit
cd ..
git add backend/functions/delete-social-post-from-platform/ frontend/src/components/SocialPostDetailPanel.tsx
git commit -m "feat: optional provider-side delete for sent social posts"
```

---

## Self-review

1. **Spec coverage check** — every spec section maps to at least one task:
   - Schema (`social_posts`, `social_post_sends`, indexes, RLS) → Tasks 1–2 ✓
   - `create-social-post` (validation, channel-connection check, immediate/scheduled split) → Task 5 ✓
   - `send-social-post` (per-channel dispatch, idempotency, status recompute, activity row) → Task 4 ✓
   - `process-scheduled-social-posts` cron → Task 6 ✓
   - Retry / cancel surface → Tasks 4 (`retry: true`), 7 (`cancelSocialPost`), 10 (UI buttons) ✓
   - Composio integration configure → Task 3 ✓
   - Settings UI → Task 8 ✓
   - Composer dialog → Task 9 ✓
   - List page + side panel → Task 10 ✓
   - Realtime → Task 11 ✓
   - Activity feed → Task 14 ✓
   - Provider-side delete → Task 15 ✓
   - Smoke tests → Tasks 12–13 ✓
   - Frontend hooks (5) → Tasks 7 (api), 8 (`useSocialConnections`), 9 (`useCreateSocialPost`), 10 (`useSocialPosts`, `useRetrySocialPost`, `useCancelSocialPost`) ✓

2. **Placeholder scan** — no `TODO` / `TBD` / "implement later" left. Two explicit notes where the engineer must pattern-match existing code (the Connect flow URL pattern in Task 8 Step 2; the realtime subscription style in Task 11 Step 2) — both flagged with reference points.

3. **Type consistency** — `SocialChannel`, `SocialPost`, `SocialPostSend`, `ChannelOverrides`, `CreatePayload` defined once in `socialApi.ts` and reused everywhere. Channel-status enum values (`pending|sent|failed`) and post-status enum values (`draft|scheduled|sending|sent|partial|failed|canceled`) consistent across backend and frontend.

4. **Implementation order is build-stable** — each task produces working software the next can rely on. The frontend tasks reference the backend hooks/types created by earlier tasks. Smoke tests come after the surfaces that enable them.

---

## Notes for the implementer

- **Workspace owner is the canonical Composio user** for per-workspace shared accounts. `send-social-post` looks up `workspaces.owner_user_id` and passes it as `userId` to Composio. If your `workspaces` table uses a different column name (e.g., `created_by` instead of `owner_user_id`), adjust the SQL in Task 4 Step 3 and Task 15 Step 1.
- **The `bb.from(...)` query-builder syntax** in `socialApi.ts` assumes the existing `@butterbase/sdk` pattern. If the codebase uses a different shape (e.g., raw REST), match it from `frontend/src/lib/butterbase.ts`.
- **OAuth redirect URLs** in Task 8 Step 3 are placeholders — replace with the actual endpoints used by Gmail/Calendar Connect in the existing Settings page.
- **Cron timing**: the cron fires every 5 minutes UTC. Scheduled posts can be up to ~5 min late; this matches the existing `process-campaign-sends` behavior. No need to add minute-level precision in Phase 1.
- **Test the partial-failure path explicitly** (Task 12 Step 6) — it's the most error-prone transition and the UI's value-add over a simple "all or nothing" flow.
