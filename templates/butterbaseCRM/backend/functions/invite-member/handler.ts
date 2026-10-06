export async function handler(req, ctx) {
  if (!ctx.user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const { workspace_id, email, role = 'member' } = body ?? {};

  if (!workspace_id || !email || typeof email !== 'string') {
    return Response.json({ error: 'workspace_id and email required' }, { status: 400 });
  }
  if (!['owner', 'admin', 'member'].includes(role)) {
    return Response.json({ error: 'invalid role' }, { status: 400 });
  }

  const normEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) {
    return Response.json({ error: 'invalid email' }, { status: 400 });
  }

  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  let invite;
  try {
    const r = await ctx.db.query(
      `INSERT INTO pending_invites (workspace_id, email, role, invited_by, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, workspace_id, email, role, token, expires_at`,
      [workspace_id, normEmail, role, ctx.user.id, token, expiresAt],
    );
    invite = r.rows[0];
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/policy|permission|rls/i.test(msg)) {
      return Response.json({ error: 'forbidden — not an admin of this workspace' }, { status: 403 });
    }
    return Response.json({ error: 'db_error', detail: msg }, { status: 500 });
  }

  const wsRow = await ctx.db.query('SELECT name FROM workspaces WHERE id = $1', [workspace_id]);
  const workspaceName = wsRow.rows[0]?.name ?? 'a workspace';

  // Auto-add the invitee to the app-wide allowlist so they can pass the
  // login gate (check-allowlist) when they click the invite link.
  let allowlistError = null;
  try {
    await ctx.db.query(
      `INSERT INTO app_allowlist (entry_type, value, active, note, created_by)
       VALUES ('email', $1, true, $2, $3)
       ON CONFLICT (entry_type, value) DO UPDATE SET active = true, updated_at = now()`,
      [normEmail, `auto-added: invited to ${workspaceName}`, ctx.user.id],
    );
  } catch (err) {
    allowlistError = String(err?.message ?? err);
    console.error('allowlist_insert_failed', allowlistError);
  }

  const inviteUrl = `${ctx.env.BUTTERBASE_FRONTEND_URL}/invite/${token}`;

  let emailSent = false;
  let emailError = null;
  try {
    const res = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
      },
      body: JSON.stringify({
        toolName: 'GOOGLESUPER_SEND_EMAIL',
        userId: ctx.user.id,
        params: {
          to: normEmail,
          subject: `You're invited to ${workspaceName} on Butterbase CRM`,
          body: `Hi,\n\nYou've been invited to join "${workspaceName}" as a ${role} on Butterbase CRM.\n\nClick to accept (expires in 7 days):\n${inviteUrl}\n\nIf you weren't expecting this, you can ignore this email.`,
        },
      }),
    });
    const out = await res.json();
    emailSent = !!out?.successful;
    if (!emailSent) emailError = typeof out?.error === 'string' ? out.error : JSON.stringify(out?.error ?? `status ${res.status}`);
  } catch (err) {
    emailError = String(err?.message ?? err);
  }

  return Response.json({
    invite_id: invite.id,
    token,
    invite_url: inviteUrl,
    expires_at: expiresAt,
    email_sent: emailSent,
    email_error: emailError,
    workspace_name: workspaceName,
    allowlist_error: allowlistError,
  });
}

