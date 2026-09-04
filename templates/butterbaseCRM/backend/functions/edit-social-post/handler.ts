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

const TERMINAL = ['sent', 'partial'];

function effBody(body, overrides, channel) {
  const o = overrides?.[channel]?.body;
  return (typeof o === 'string' && o.length > 0) ? o : body;
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let input;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { post_id, patch = {}, push_to_platform = false } = input || {};
  if (!post_id) return json(400, { error: 'missing post_id' });

  const postRes = await ctx.db.query(`SELECT * FROM social_posts WHERE id = $1`, [post_id]);
  const post = postRes.rows?.[0];
  if (!post) return json(404, { error: 'post_not_found' });

  const memRes = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [post.workspace_id, ctx.user.id],
  );
  if (!memRes.rows?.[0]) return json(403, { error: 'not_a_member' });

  // 'sending' is mid-flight — don't let an edit race the dispatcher.
  if (post.status === 'sending') return json(409, { error: 'post_is_sending' });

  // Merge the patch over current values (only provided keys change).
  const next = {
    body: typeof patch.body === 'string' ? patch.body : post.body,
    channels: Array.isArray(patch.channels) ? patch.channels : post.channels,
    channel_overrides: patch.channel_overrides ?? post.channel_overrides ?? {},
    link_url: 'link_url' in patch ? (patch.link_url || null) : post.link_url,
    scheduled_at: 'scheduled_at' in patch ? (patch.scheduled_at || null) : post.scheduled_at,
  };

  if (typeof next.body !== 'string' || next.body.length === 0) {
    return json(400, { error: 'body required' });
  }

  await ctx.db.query(
    `UPDATE social_posts
        SET body = $2, channels = $3, channel_overrides = $4::jsonb,
            link_url = $5, scheduled_at = $6, updated_at = now()
      WHERE id = $1`,
    [post_id, next.body, next.channels, JSON.stringify(next.channel_overrides), next.link_url, next.scheduled_at],
  );

  // For not-yet-published posts, keep pending sends in sync with the channel set.
  if (!TERMINAL.includes(post.status)) {
    await ctx.db.query(
      `DELETE FROM social_post_sends
        WHERE post_id = $1 AND status <> 'sent' AND channel <> ALL($2::text[])`,
      [post_id, next.channels],
    );
  }

  // Optionally push the edit to the live platform post (body only).
  // Reddit can edit a self-post's body; titles, link posts, LinkedIn and X can't.
  const platform = [];
  if (push_to_platform && TERMINAL.includes(post.status)) {
    const ownerRes = await ctx.db.query(`SELECT owner_user_id FROM workspaces WHERE id = $1`, [post.workspace_id]);
    const ownerId = ownerRes.rows?.[0]?.owner_user_id;
    const sendsRes = await ctx.db.query(
      `SELECT * FROM social_post_sends WHERE post_id = $1 AND status = 'sent' AND external_post_id IS NOT NULL`,
      [post_id],
    );
    for (const s of (sendsRes.rows ?? [])) {
      if (s.channel === 'reddit') {
        const r = await composio(ctx, 'REDDIT_EDIT_REDDIT_COMMENT_OR_POST', {
          thing_id: s.external_post_id,
          text: effBody(next.body, next.channel_overrides, 'reddit'),
        }, ownerId);
        platform.push({ channel: 'reddit', ok: r.ok, error: r.error ?? null });
      } else {
        platform.push({ channel: s.channel, ok: false, error: `${s.channel}: editing a published post is not supported by the platform` });
      }
    }
  }

  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'social_post_edited', 'social_post', $3, $4::jsonb)`,
    [post.workspace_id, ctx.user.id, post_id, JSON.stringify({ pushed: push_to_platform, platform })],
  );

  return json(200, { ok: true, id: post_id, status: post.status, platform });
}

