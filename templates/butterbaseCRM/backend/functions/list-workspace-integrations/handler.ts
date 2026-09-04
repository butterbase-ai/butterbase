/**
 * list-workspace-integrations
 *
 * Returns the social integrations bound to a workspace, regardless of which
 * member performed the OAuth. The frontend uses this so every member sees the
 * same "Connected" state for workspace-shared social accounts.
 *
 * Body: { workspace_id: string, toolkits?: string[] }
 */

const SOCIAL_TOOLKITS = ['twitter', 'linkedin', 'reddit'];

export async function handler(req, ctx) {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);

  let body = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const workspaceId = body.workspace_id;
  if (!workspaceId) return json({ error: 'missing_workspace_id' }, 400);

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, ctx.user.id],
  );
  if (m.rows.length === 0) return json({ error: 'not_a_member' }, 403);

  const toolkits = (body.toolkits?.length ? body.toolkits : SOCIAL_TOOLKITS);

  const r = await ctx.db.query(
    `SELECT toolkit_slug, user_id AS connected_by_user_id, connected_at, composio_account_id
       FROM workspace_integrations
      WHERE workspace_id = $1 AND toolkit_slug = ANY($2::text[])
      ORDER BY connected_at ASC`,
    [workspaceId, toolkits],
  );

  return json({ ok: true, integrations: r.rows ?? [] });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

