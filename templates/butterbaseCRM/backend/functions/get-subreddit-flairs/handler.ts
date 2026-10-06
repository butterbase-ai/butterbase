function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Canonical integration call: rides on the auto-injected
// BUTTERBASE_FUNCTION_SERVICE_KEY — no BUTTERBASE_API_KEY env var required.
async function composio(ctx, toolName, params, userId) {
  try {
    const res = await ctx.integrations.asUser(userId).execute(toolName, params);
    if (res && res.successful === false) return { ok: false, error: res.error ?? 'integration_failed' };
    return { ok: true, data: (res && res.data) ?? res ?? {} };
  } catch (e) {
    return { ok: false, error: `integrations: ${e?.message ?? String(e)}` };
  }
}

// Reddit flair richtext → flat label, with sensible fallbacks.
function flairText(f) {
  if (typeof f?.text === 'string' && f.text) return f.text;
  if (Array.isArray(f?.richtext)) return f.richtext.map(p => p?.t ?? '').join('').trim();
  return f?.css_class ?? '';
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { workspace_id } = body || {};
  // Accept the subreddit with or without a leading r/ or slashes.
  const subreddit = String(body?.subreddit ?? '').trim().replace(/^\/?r\//i, '').replace(/\//g, '');

  if (!workspace_id) return json(400, { error: 'workspace_id required' });
  if (!subreddit) return json(400, { error: 'subreddit required' });

  // Caller must be a member of the workspace whose Reddit account we use.
  const memRes = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspace_id, ctx.user.id],
  );
  if (!memRes.rows?.[0]) return json(403, { error: 'not_a_member' });

  // Reddit is connected on the workspace owner's account (same as send-social-post).
  const connRes = await ctx.db.query(
    `SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = 'reddit' LIMIT 1`,
    [workspace_id],
  );
  if (!connRes.rows?.[0]) return json(400, { error: 'reddit_not_connected' });

  const ownerRes = await ctx.db.query(
    `SELECT owner_user_id FROM workspaces WHERE id = $1`,
    [workspace_id],
  );
  const ownerId = ownerRes.rows?.[0]?.owner_user_id;
  if (!ownerId) return json(500, { error: 'no_workspace_owner' });

  const res = await composio(ctx, 'REDDIT_LIST_SUBREDDIT_POST_FLAIRS', { subreddit }, ownerId);
  if (!res.ok) return json(502, { error: res.error });

  const raw = res.data?.flairs ?? res.data?.data?.flairs ?? [];
  const flairs = (Array.isArray(raw) ? raw : [])
    // mod-only flairs can't be set by a normal submit, so hide them.
    .filter(f => !f?.mod_only)
    .map(f => ({ id: f.id, text: flairText(f), css_class: f.css_class ?? null }))
    .filter(f => f.id);

  return json(200, {
    subreddit,
    flair_required: flairs.length > 0, // best-effort hint; subreddit may still allow no-flair posts
    flairs,
  });
}

