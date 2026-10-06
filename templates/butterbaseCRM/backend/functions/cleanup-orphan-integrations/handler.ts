/**
 * cleanup-orphan-integrations  (cron: daily)
 *
 * Catches Composio connections whose user no longer has any
 * workspace_integrations row for that toolkit — typically because:
 *   - their membership was deleted (workspace_integrations cascade-dropped via
 *     workspace deletion, OR via unregister-integration on disconnect)
 *   - they joined the app, OAuthed a toolkit, but never registered a binding
 *
 * Runs as service (cron) — ctx.user is null and DB queries bypass RLS.
 *
 * Uses the platform API key path to disconnect via DELETE on Composio
 * connection ids.
 */

export async function handler(_req, ctx) {
  // List every Composio connection on the app.
  const listUrl = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/config`;
  // Note: REST API spec doesn't expose a service-level "list_connected" — we
  // emit a thin call via the manage_integrations REST endpoint instead.
  // Most apps will deploy this against the operator dashboard's MCP path; for
  // self-hosted disconnect we fall back to per-user list inside the loop.
  const allConnections = await listAllConnections(ctx);

  let inspected = 0;
  let orphans: { connection_id: string; user_id: string; toolkit: string }[] = [];
  let disconnected = 0;
  let failures: string[] = [];

  for (const conn of allConnections) {
    inspected++;
    const userId = conn.app_user_id;
    const toolkit = conn.toolkit_slug;
    if (!userId || !toolkit) continue;

    const r = await ctx.db.query(
      'SELECT 1 FROM workspace_integrations WHERE user_id = $1 AND toolkit_slug = $2 LIMIT 1',
      [userId, toolkit],
    );
    if (r.rows.length > 0) continue;

    orphans.push({ connection_id: conn.id, user_id: userId, toolkit });
    const ok = await deleteComposioConnection(ctx, conn.id);
    if (ok) disconnected++;
    else failures.push(conn.id);
  }

  return new Response(
    JSON.stringify({ inspected, orphan_count: orphans.length, disconnected, failures, orphans }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function listAllConnections(ctx): Promise<any[]> {
  // Service-API endpoint to list every connected user on this app.
  // Mirrors what `manage_integrations action=list_connected` returns.
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connections?all=true`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
  });
  if (!res.ok) return [];
  const payload = await res.json();
  return Array.isArray(payload?.connections) ? payload.connections : [];
}

async function deleteComposioConnection(ctx, connectionId: string): Promise<boolean> {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/connections/${connectionId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
  });
  return res.ok;
}

