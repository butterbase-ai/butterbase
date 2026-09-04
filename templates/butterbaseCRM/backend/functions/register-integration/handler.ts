/**
 * register-integration
 *
 * Bind a freshly-OAuthed Composio connection to a workspace. Called by the
 * frontend right after `bb.integrations.connect()` returns control to the
 * Settings page (i.e. inside the integration_status=success branch of the
 * OAuth callback handler).
 *
 * Body: { workspace_id: string, toolkit: 'gmail' | 'google-calendar' | ... }
 *
 * Verifies:
 *   - caller is a member of the workspace (RLS would already block, but we
 *     also want a clean 403 instead of a row-violation)
 *   - caller actually has an active Composio connection for this toolkit
 *
 * Stores the composio_account_id snapshot so cleanup-orphan-integrations can
 * disconnect by id later without re-listing.
 */

export async function handler(req, ctx) {
  if (!ctx.user) {
    return json({ error: 'unauthorized' }, 401);
  }
  const userId = ctx.user.id;

  let body: { workspace_id?: string; toolkit?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const workspaceId = body.workspace_id;
  const toolkit = body.toolkit;
  if (!workspaceId || !toolkit) {
    return json({ error: 'missing_fields', detail: 'workspace_id and toolkit are required' }, 400);
  }

  // Membership check.
  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, userId],
  );
  if (m.rows.length === 0) {
    return json({ error: 'not_a_member' }, 403);
  }

  // Look up the Composio connection.
  const conn = await findComposioConnection(ctx, req, userId, toolkit);
  if (!conn) {
    return json({ error: 'not_connected', detail: `No active ${toolkit} connection found for this user. Run OAuth first.` }, 409);
  }

  // Upsert binding.
  await ctx.db.query(
    `INSERT INTO workspace_integrations (workspace_id, user_id, toolkit_slug, composio_account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, user_id, toolkit_slug)
     DO UPDATE SET composio_account_id = EXCLUDED.composio_account_id, connected_at = now()`,
    [workspaceId, userId, toolkit, conn.composio_account_id ?? null],
  );

  return json({ ok: true, workspace_id: workspaceId, toolkit, composio_account_id: conn.composio_account_id });
}

async function findComposioConnection(ctx, req: Request, userId: string, toolkit: string) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connections`;
  const res = await fetch(url, {
    headers: { authorization: req.headers.get('authorization') ?? '' },
  });
  if (!res.ok) return null;
  const payload = await res.json();
  const list = Array.isArray(payload?.connections) ? payload.connections : [];
  return list.find(
    (c: any) => c.toolkit_slug === toolkit && c.status === 'active' && (c.app_user_id ?? userId) === userId,
  ) ?? null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

