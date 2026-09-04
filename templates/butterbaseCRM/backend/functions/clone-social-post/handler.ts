function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// "Repost": duplicate an existing post (any status) into a fresh editable draft.
// The clone has no sends rows yet — publish-social-post creates them when sent.
export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { post_id } = body || {};
  if (!post_id) return json(400, { error: 'missing post_id' });

  const srcRes = await ctx.db.query(`SELECT * FROM social_posts WHERE id = $1`, [post_id]);
  const src = srcRes.rows?.[0];
  if (!src) return json(404, { error: 'post_not_found' });

  const memRes = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [src.workspace_id, ctx.user.id],
  );
  if (!memRes.rows?.[0]) return json(403, { error: 'not_a_member' });

  const ins = await ctx.db.query(
    `INSERT INTO social_posts (workspace_id, created_by, body, channels, channel_overrides, link_url, scheduled_at, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NULL, 'draft')
     RETURNING id, status`,
    [
      src.workspace_id,
      ctx.user.id,
      src.body,
      src.channels,
      JSON.stringify(src.channel_overrides ?? {}),
      src.link_url ?? null,
    ],
  );

  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'social_post_cloned', 'social_post', $3, $4::jsonb)`,
    [src.workspace_id, ctx.user.id, ins.rows[0].id, JSON.stringify({ from: post_id })],
  );

  return json(200, { id: ins.rows[0].id, status: 'draft', cloned_from: post_id });
}

