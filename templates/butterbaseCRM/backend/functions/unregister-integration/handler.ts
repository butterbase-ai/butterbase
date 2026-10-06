/**
 * unregister-integration
 *
 * Frontend "Disconnect" button calls this.
 *
 * Body: { workspace_id: string, toolkit: string }
 */

// One toolkit (googlesuper) maps to multiple integration_state rows — Gmail and
// Calendar each track their own watermark even though they share an OAuth.
const TOOLKIT_TO_STATE_KINDS = {
  'googlesuper': ['gmail', 'calendar'],
};

// Social toolkits are workspace-shared: any member can disconnect the
// workspace's binding regardless of who originally linked it. Personal-data
// toolkits (gmail/calendar/etc) stay per-user — disconnecting only affects
// the calling user's own row.
const WORKSPACE_SHARED_TOOLKITS = new Set(['twitter', 'linkedin', 'reddit']);

export async function handler(req, ctx) {
  if (!ctx.user) {
    return json({ error: 'unauthorized' }, 401);
  }
  const userId = ctx.user.id;

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const workspaceId = body.workspace_id;
  const toolkit = body.toolkit;
  if (!workspaceId || !toolkit) {
    return json({ error: 'missing_fields' }, 400);
  }

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, userId],
  );
  if (m.rows.length === 0) {
    return json({ error: 'not_a_member' }, 403);
  }

  const workspaceShared = WORKSPACE_SHARED_TOOLKITS.has(toolkit);

  const beforeSql = workspaceShared
    ? 'SELECT composio_account_id, user_id FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = $2'
    : 'SELECT composio_account_id, user_id FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = $2 AND user_id = $3';
  const beforeParams = workspaceShared ? [workspaceId, toolkit] : [workspaceId, toolkit, userId];
  const before = await ctx.db.query(beforeSql, beforeParams);
  const rowsRemoved = before.rows ?? [];
  const accountIdSnapshot = rowsRemoved[0]?.composio_account_id ?? null;
  const ownerUserId = rowsRemoved[0]?.user_id ?? null;

  const deleteSql = workspaceShared
    ? 'DELETE FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = $2'
    : 'DELETE FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = $2 AND user_id = $3';
  await ctx.db.query(deleteSql, beforeParams);

  const stateKinds = TOOLKIT_TO_STATE_KINDS[toolkit] ?? [];
  for (const kind of stateKinds) {
    await ctx.db.query(
      'DELETE FROM integration_state WHERE workspace_id = $1 AND kind = $2',
      [workspaceId, kind],
    );
  }

  const r = await ctx.db.query(
    'SELECT count(*)::int AS n FROM workspace_integrations WHERE user_id = $1 AND toolkit_slug = $2',
    [userId, toolkit],
  );
  const remaining = r.rows[0]?.n ?? 0;

  let composioDisconnected = false;
  const callerOwnedConnection = !workspaceShared || ownerUserId === userId;
  if (remaining === 0 && callerOwnedConnection) {
    const connectionId = await resolveComposioConnectionId(ctx, req, userId, toolkit, accountIdSnapshot);
    if (connectionId) {
      composioDisconnected = await deleteComposioConnection(ctx, req, connectionId);
    }
  }

  return json({
    ok: true,
    workspace_id: workspaceId,
    toolkit,
    remaining_bindings_for_user: remaining,
    composio_disconnected: composioDisconnected,
  });
}

async function resolveComposioConnectionId(ctx, req, userId, toolkit, accountIdSnapshot) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connections`;
  const res = await fetch(url, {
    headers: { authorization: req.headers.get('authorization') ?? '' },
  });
  if (!res.ok) return null;
  const payload = await res.json();
  const list = Array.isArray(payload?.connections) ? payload.connections : [];
  const match =
    (accountIdSnapshot && list.find((c) => c.composio_account_id === accountIdSnapshot)) ||
    list.find((c) => c.toolkit_slug === toolkit && (c.app_user_id ?? userId) === userId);
  return match?.id ?? null;
}

async function deleteComposioConnection(ctx, req, connectionId) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connections/${connectionId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: req.headers.get('authorization') ?? '' },
  });
  return res.ok;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

