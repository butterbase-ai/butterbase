function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const { workspace_id, list_id, name, description, entity_type, source, source_spec, members } = body ?? {};
  if (!workspace_id) return json(400, { error: 'workspace_id required' });
  if (!Array.isArray(members)) return json(400, { error: 'members must be an array' });
  if (members.length > 500) return json(400, { error: 'too_many_members (max 500)' });

  const addingToExisting = typeof list_id === 'string' && list_id.length > 0;

  if (!addingToExisting) {
    if (!name || typeof name !== 'string') return json(400, { error: 'name required' });
    if (entity_type !== 'people' && entity_type !== 'companies') return json(400, { error: 'entity_type must be people|companies' });
    if (source !== 'manual' && source !== 'ai_search') return json(400, { error: 'source must be manual|ai_search' });
  }

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspace_id, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });

  const normalised = [];
  const seen = new Set();
  for (const raw of members) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue;
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    normalised.push({
      id: raw.id,
      email: typeof raw.email === 'string' && raw.email ? raw.email : null,
      vars: raw.vars && typeof raw.vars === 'object' ? raw.vars : null,
    });
  }

  let list;
  let effectiveEntityType;

  if (addingToExisting) {
    const res = await ctx.db.query(
      `SELECT * FROM campaign_lists WHERE id = $1 LIMIT 1`,
      [list_id],
    );
    if (res.rows.length === 0) return json(404, { error: 'list_not_found' });
    list = res.rows[0];
    if (list.workspace_id !== workspace_id) return json(403, { error: 'list_wrong_workspace' });
    effectiveEntityType = list.entity_type;
  } else {
    const listRes = await ctx.db.query(
      `INSERT INTO campaign_lists (workspace_id, name, description, entity_type, source, source_spec, created_by, member_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [workspace_id, name.trim(), description ?? null, entity_type, source, source === 'ai_search' ? source_spec ?? null : null, ctx.user.id, normalised.length],
    );
    list = listRes.rows[0];
    effectiveEntityType = entity_type;
  }

  let insertedCount = normalised.length;
  if (normalised.length > 0) {
    const values = [];
    const params = [];
    let p = 1;
    for (const row of normalised) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(workspace_id, list.id, effectiveEntityType, row.id, row.email, row.vars ? JSON.stringify(row.vars) : null, ctx.user.id);
    }
    const insRes = await ctx.db.query(
      `INSERT INTO campaign_list_members (workspace_id, list_id, entity_type, entity_id, email_snapshot, vars_snapshot, added_by)
       VALUES ${values.join(', ')}
       ON CONFLICT (list_id, entity_type, entity_id) DO NOTHING
       RETURNING id`,
      params,
    );
    insertedCount = insRes.rows.length;

    if (addingToExisting) {
      const upd = await ctx.db.query(
        `UPDATE campaign_lists
         SET member_count = (SELECT COUNT(*) FROM campaign_list_members WHERE list_id = $1),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [list.id],
      );
      list = upd.rows[0];
    }
  }

  return json(200, { list, member_count: insertedCount, requested_count: normalised.length });
}
