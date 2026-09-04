function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Canonical integration call: rides on the auto-injected
// BUTTERBASE_FUNCTION_SERVICE_KEY — no BUTTERBASE_API_KEY env var required.
async function composio(ctx, toolName, params, userId) {
  try {
    const res = await ctx.integrations.asUser(userId).execute(toolName, params);
    if (res && res.successful === false) return { ok: false, error: res.error ?? 'platform_returned_failure' };
    return { ok: true, data: (res && res.data) ?? res ?? {} };
  } catch (e) {
    return { ok: false, error: `integrations: ${e?.message ?? String(e)}` };
  }
}

const DELETE_TOOL = {
  twitter: 'TWITTER_POST_DELETE_BY_POST_ID',
  linkedin: 'LINKEDIN_DELETE_LINKED_IN_POST',
  reddit: 'REDDIT_DELETE_REDDIT_POST',
  instagram: 'INSTAGRAM_DELETE_MEDIA',
  // tiktok handled separately (no API).
};

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { send_id } = body || {};
  if (!send_id) return json(400, { error: 'missing send_id' });

  const sendRes = await ctx.db.query(
    `SELECT s.*, p.workspace_id AS post_workspace_id, p.created_by
       FROM social_post_sends s
       JOIN social_posts p ON p.id = s.post_id
      WHERE s.id = $1`,
    [send_id],
  );
  const send = sendRes.rows?.[0];
  if (!send) return json(404, { error: 'send_not_found' });

  const memRes = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [send.post_workspace_id, ctx.user.id],
  );
  if (!memRes.rows?.[0]) return json(403, { error: 'not_a_member' });

  if (send.channel === 'tiktok') {
    return json(200, { ok: false, error: 'tiktok: platform does not support programmatic delete' });
  }
  if (send.channel === 'instagram') {
    const postRes = await ctx.db.query(
      `SELECT channel_overrides FROM social_posts WHERE id = $1`,
      [send.post_id],
    );
    const postType = postRes.rows?.[0]?.channel_overrides?.instagram?.post_type;
    if (postType === 'story') {
      await ctx.db.query(
        `UPDATE social_post_sends SET external_post_id = NULL, external_url = NULL WHERE id = $1`,
        [send_id],
      );
      return json(200, { ok: true, note: 'stories auto-expire in 24h; nothing to delete on Instagram' });
    }
  }

  if (!send.external_post_id) return json(400, { error: 'no_external_post_id' });

  const tool = DELETE_TOOL[send.channel];
  if (!tool) return json(400, { error: `unsupported channel: ${send.channel}` });

  // Use the workspace-shared connection for this toolkit (any member's OAuth),
  // not the workspace owner — owners may not be the ones who linked the account.
  const intRes = await ctx.db.query(
    `SELECT user_id FROM workspace_integrations
      WHERE workspace_id = $1 AND toolkit_slug = $2
      ORDER BY connected_at ASC
      LIMIT 1`,
    [send.post_workspace_id, send.channel],
  );
  const connectedUserId = intRes.rows?.[0]?.user_id;
  if (!connectedUserId) return json(409, { error: 'no_workspace_connection_for_channel' });

  const params = send.channel === 'instagram'
    ? { media_id: send.external_post_id }
    : { id: send.external_post_id };
  const result = await composio(ctx, tool, params, connectedUserId);
  if (!result.ok) return json(502, { error: result.error ?? 'platform_delete_failed' });

  await ctx.db.query(
    `UPDATE social_post_sends SET external_post_id = NULL, external_url = NULL WHERE id = $1`,
    [send_id],
  );
  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'social_post_removed_from_platform', 'social_post', $3, $4::jsonb)`,
    [send.post_workspace_id, ctx.user.id, send.post_id, JSON.stringify({ channel: send.channel })],
  );

  return json(200, { ok: true });
}
