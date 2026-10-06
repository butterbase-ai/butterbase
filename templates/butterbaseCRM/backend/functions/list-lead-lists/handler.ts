// backend/functions/list-lead-lists/handler.ts
//
// Returns the workspace's "people" campaign_lists — used by Lead Finder's
// AddToListDialog dropdown. Same data source as the Campaigns page.

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const workspaceId = String(body?.workspace_id ?? '');
  if (!workspaceId) return json(400, { error: 'workspace_id_required' });

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });

  const res = await ctx.db.query(
    `SELECT id, name, member_count, updated_at
     FROM campaign_lists
     WHERE workspace_id = $1 AND entity_type = 'people'
     ORDER BY updated_at DESC
     LIMIT 200`,
    [workspaceId],
  );

  const lists = res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    member_count: r.member_count ?? 0,
    last_added_at: r.updated_at,
  }));

  return json(200, { lists });
}

