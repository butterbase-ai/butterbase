export async function handler(req, ctx) {
  // auth: 'none' means service role, but x-user-id is still forwarded when the caller sent a JWT.
  const userId = req.headers.get('x-user-id');
  if (!userId) {
    return Response.json({ error: 'sign in first, then click the invite link again' }, { status: 401 });
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const { token } = body ?? {};
  if (!token || typeof token !== 'string') {
    return Response.json({ error: 'token required' }, { status: 400 });
  }

  // Lookup invite (service role bypasses RLS).
  const inviteR = await ctx.db.query(
    'SELECT id, workspace_id, role, expires_at FROM pending_invites WHERE token = $1',
    [token],
  );
  if (inviteR.rows.length === 0) {
    return Response.json({ error: 'invite not found or already used' }, { status: 404 });
  }
  const invite = inviteR.rows[0];
  if (new Date(invite.expires_at) < new Date()) {
    return Response.json({ error: 'invite expired' }, { status: 410 });
  }

  const wsR = await ctx.db.query('SELECT name FROM workspaces WHERE id = $1', [invite.workspace_id]);
  const workspaceName = wsR.rows[0]?.name ?? null;

  // Insert membership; ON CONFLICT (workspace_id, user_id) means user is already a member — fine.
  await ctx.db.query(
    `INSERT INTO memberships (workspace_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [invite.workspace_id, userId, invite.role],
  );

  // Delete the redeemed invite.
  await ctx.db.query('DELETE FROM pending_invites WHERE id = $1', [invite.id]);

  return Response.json({
    workspace_id: invite.workspace_id,
    workspace_name: workspaceName,
    role: invite.role,
  });
}

