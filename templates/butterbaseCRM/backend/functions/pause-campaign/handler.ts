function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const campaignId = body?.campaign_id;
  const action = body?.action;
  if (!campaignId) return json(400, { error: 'campaign_id required' });
  if (!['pause', 'resume', 'cancel'].includes(action)) return json(400, { error: 'action must be pause|resume|cancel' });

  const c = await ctx.db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  if (c.rows.length === 0) return json(404, { error: 'not_found' });
  const campaign = c.rows[0];

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [campaign.workspace_id, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });

  let next = null;
  if (action === 'pause' && campaign.status === 'active') next = 'paused';
  else if (action === 'resume' && campaign.status === 'paused') next = 'active';
  else if (action === 'cancel' && ['active', 'paused', 'draft'].includes(campaign.status)) next = 'cancelled';
  if (!next) return json(409, { error: 'invalid_transition', from: campaign.status, action });

  await ctx.db.query(
    `UPDATE campaigns
        SET status = $2,
            completed_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE completed_at END,
            updated_at = now()
      WHERE id = $1`,
    [campaign.id, next],
  );

  if (next === 'cancelled') {
    await ctx.db.query(
      `UPDATE campaign_sends SET status = 'cancelled', updated_at = now()
       WHERE campaign_id = $1 AND status = 'queued'`,
      [campaign.id],
    );
  }

  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, 'campaign', $4, $5::jsonb)`,
    [campaign.workspace_id, ctx.user.id, `campaign.${next}`, campaign.id, JSON.stringify({ name: campaign.name })],
  ).catch(() => {});

  return json(200, { status: next });
}

