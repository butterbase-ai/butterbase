function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const workspaceId = body?.workspace_id;
  if (!workspaceId) return json(400, { error: 'workspace_id required' });

  const m = await ctx.db.query(
    `SELECT role FROM memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });
  if (!['owner', 'admin'].includes(m.rows[0].role)) return json(403, { error: 'not_admin' });

  const patch = {};
  if (typeof body?.google_autosync_enabled === 'boolean') patch.google_autosync_enabled = body.google_autosync_enabled;
  if (typeof body?.notetaker_auto_enabled === 'boolean') patch.notetaker_auto_enabled = body.notetaker_auto_enabled;
  if (typeof body?.notetaker_name === 'string') patch.notetaker_name = body.notetaker_name;

  await ctx.db.query(
    `INSERT INTO sync_settings (workspace_id) VALUES ($1)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId],
  );

  if (Object.keys(patch).length > 0) {
    const cols = Object.keys(patch);
    const values = [workspaceId, ...Object.values(patch)];
    const sets = cols.map((c, idx) => `${c} = $${idx + 2}`).join(', ');
    await ctx.db.query(
      `UPDATE sync_settings
          SET ${sets}, updated_at = now()
        WHERE workspace_id = $1`,
      values,
    );
  }

  const out = await ctx.db.query(
    `SELECT * FROM sync_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  return json(200, out.rows[0]);
}

