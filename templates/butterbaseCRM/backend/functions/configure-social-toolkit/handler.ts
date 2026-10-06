/**
 * configure-social-toolkit
 *
 * Workspace-owner-facing: register BYO OAuth credentials for a non-curated
 * social toolkit (twitter / linkedin / reddit) on this app. This is what the
 * Settings → Social accounts → "Configure X app credentials" wizard calls.
 *
 * Body: {
 *   workspace_id: string,
 *   toolkit: 'twitter' | 'linkedin' | 'reddit',
 *   client_id: string,
 *   client_secret: string,
 *   bearer_token?: string,   // twitter only — maps to Composio's `generic_id`
 *   display_name?: string,
 * }
 *
 * Calls Butterbase's POST /v1/<app_id>/integrations/configure with the
 * service API key (the call requires admin scope, which the user's JWT
 * doesn't carry — the function authenticates the user, then calls upstream
 * with BUTTERBASE_API_KEY on their behalf).
 */

const TOOLKIT_SCOPES: Record<string, string[]> = {
  twitter: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
  linkedin: ['openid', 'profile', 'email', 'w_member_social'],
  reddit: ['identity', 'submit', 'read', 'flair', 'comment'],
  instagram: [],
  tiktok: ['user.info.basic', 'video.upload', 'video.publish'],
};

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json({ error: 'unauthorized' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const { workspace_id, toolkit, client_id, client_secret, bearer_token, display_name } = body;

  const requiresByo = toolkit !== 'instagram';
  if (!workspace_id || !toolkit || (requiresByo && (!client_id || !client_secret))) {
    return json({ error: 'missing_fields', detail: 'workspace_id, toolkit, client_id and client_secret are required (Instagram excepted)' }, 400);
  }
  if (!(toolkit in TOOLKIT_SCOPES)) {
    return json({ error: 'unsupported_toolkit', detail: `toolkit must be one of: ${Object.keys(TOOLKIT_SCOPES).join(', ')}` }, 400);
  }
  if (toolkit === 'twitter' && !bearer_token) {
    return json({ error: 'missing_fields', detail: 'twitter requires bearer_token (the X Application Bearer Token)' }, 400);
  }

  // Workspace-admin check. Only owners/admins can configure app-wide creds.
  const m = await ctx.db.query(
    `SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspace_id, ctx.user.id],
  );
  if (m.rows.length === 0) return json({ error: 'not_a_member' }, 403);
  const role = m.rows[0].role;
  if (role !== 'owner' && role !== 'admin') {
    return json({ error: 'forbidden', detail: 'Only workspace owners or admins can configure app credentials.' }, 403);
  }

  const apiKey = ctx.env.BUTTERBASE_API_KEY;
  const appId = ctx.env.BUTTERBASE_APP_ID;
  if (!apiKey || !appId) {
    return json({ error: 'misconfigured', detail: 'Function missing BUTTERBASE_API_KEY or BUTTERBASE_APP_ID env vars.' }, 500);
  }

  const oauth_credentials: Record<string, string> | undefined =
    toolkit === 'instagram' ? undefined : { client_id, client_secret };
  if (toolkit === 'twitter') oauth_credentials!.generic_id = bearer_token!;

  const upstream = await fetch(`https://api.butterbase.ai/v1/${appId}/integrations/configure`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      toolkit,
      scopes: TOOLKIT_SCOPES[toolkit],
      displayName: display_name ?? undefined,
      ...(oauth_credentials ? { oauth_credentials } : {}),
    }),
  });

  const upstreamPayload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    return json({
      error: 'configure_failed',
      upstream_status: upstream.status,
      upstream: upstreamPayload,
    }, upstream.status === 400 ? 400 : 502);
  }

  return json({ ok: true, toolkit, composio_auth_config_id: upstreamPayload.composio_auth_config_id ?? null });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}


