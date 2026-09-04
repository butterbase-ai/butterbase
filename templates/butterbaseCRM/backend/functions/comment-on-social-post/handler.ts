// Verified Composio action names:
// Reddit:   REDDIT_POST_REDDIT_COMMENT  (params: thing_id, text)
// LinkedIn: LINKEDIN_CREATE_COMMENT_ON_POST (params: actor, object, target_urn, message.text)

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function composio(ctx: any, toolName: string, params: Record<string, unknown>, userId: string) {
  try {
    const res = await ctx.integrations.asUser(userId).execute(toolName, params);
    if (res && res.successful === false) return { ok: false, error: res.error ?? 'composio_returned_failure' };
    const errNode = res?.error ?? res?.data?.error ?? res?.data?.errors;
    if (errNode) {
      const flat = typeof errNode === 'string'
        ? errNode
        : (errNode.message ?? errNode.detail ?? errNode.title ?? JSON.stringify(errNode));
      return { ok: false, error: String(flat).slice(0, 500) };
    }
    return { ok: true, data: (res && res.data) ?? res ?? {} };
  } catch (e: any) {
    return { ok: false, error: `integrations: ${e?.message ?? String(e)}` };
  }
}

async function resolveWorkspaceIntegration(ctx: any, workspaceId: string, toolkit: string) {
  const r = await ctx.db.query(
    `SELECT id, user_id, metadata FROM workspace_integrations
      WHERE workspace_id = $1 AND toolkit_slug = $2
      ORDER BY connected_at ASC
      LIMIT 1`,
    [workspaceId, toolkit],
  );
  return r.rows?.[0] ?? null;
}

const COMMENT_LIMITS = {
  reddit: 10000,
  linkedin: 1250,
};

const VALID_CHANNELS = ['reddit', 'linkedin'] as const;
type CommentChannel = typeof VALID_CHANNELS[number];

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let input: any;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const { workspace_id, channel, target_post_id, target_post_url, body, entity_type, entity_id, comment_id: retryId, retry } = input ?? {};

  let commentId: string;
  let resolvedWorkspaceId: string;
  let resolvedChannel: CommentChannel;
  let resolvedTargetPostId: string;
  let resolvedBody: string;
  let resolvedEntityType: string | null;
  let resolvedEntityId: string | null;

  if (retry && retryId) {
    const existing = await ctx.db.query(
      `SELECT * FROM social_comments WHERE id = $1 LIMIT 1`,
      [retryId],
    );
    const row = existing.rows?.[0];
    if (!row) return json(404, { error: 'comment not found' });

    const memCheck = await ctx.db.query(
      `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [row.workspace_id, ctx.user.id],
    );
    if (!memCheck.rows?.[0]) return json(403, { error: 'not_a_member' });

    commentId = row.id;
    resolvedWorkspaceId = row.workspace_id;
    resolvedChannel = row.channel as CommentChannel;
    resolvedTargetPostId = row.target_post_id;
    resolvedBody = row.body;
    resolvedEntityType = row.entity_type;
    resolvedEntityId = row.entity_id;

    await ctx.db.query(`UPDATE social_comments SET status='pending', error=null, updated_at=now() WHERE id=$1`, [commentId]);
  } else {
    if (!workspace_id) return json(400, { error: 'workspace_id required' });
    if (!VALID_CHANNELS.includes(channel)) return json(400, { error: 'channel must be reddit or linkedin' });
    if (!target_post_id || typeof target_post_id !== 'string') return json(400, { error: 'target_post_id required' });
    if (!body || typeof body !== 'string' || body.trim().length === 0) return json(400, { error: 'body required' });
    if (body.length > COMMENT_LIMITS[channel as CommentChannel]) {
      return json(400, { error: `body exceeds ${COMMENT_LIMITS[channel as CommentChannel]} chars for ${channel}` });
    }

    const memRes = await ctx.db.query(
      `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
      [workspace_id, ctx.user.id],
    );
    if (!memRes.rows?.[0]) return json(403, { error: 'not_a_member' });

    const insertRes = await ctx.db.query(
      `INSERT INTO social_comments
         (workspace_id, created_by, channel, target_post_id, target_post_url, body, status, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
       RETURNING id`,
      [workspace_id, ctx.user.id, channel, target_post_id, target_post_url ?? null, body, entity_type ?? null, entity_id ?? null],
    );

    commentId = insertRes.rows[0].id;
    resolvedWorkspaceId = workspace_id;
    resolvedChannel = channel as CommentChannel;
    resolvedTargetPostId = target_post_id;
    resolvedBody = body;
    resolvedEntityType = entity_type ?? null;
    resolvedEntityId = entity_id ?? null;
  }

  const integration = await resolveWorkspaceIntegration(ctx, resolvedWorkspaceId, resolvedChannel);
  if (!integration) return json(400, { error: `${resolvedChannel}: workspace has no connected account` });

  let result: { ok: boolean; data?: any; error?: string };

  if (resolvedChannel === 'reddit') {
    result = await composio(ctx, 'REDDIT_POST_REDDIT_COMMENT', {
      thing_id: resolvedTargetPostId,
      text: resolvedBody,
    }, integration.user_id);
    console.log('reddit result:', JSON.stringify(result));
  } else {
    let urn: string | null = integration.metadata?.linkedin_author_urn ?? null;
    if (!urn) {
      const info = await composio(ctx, 'LINKEDIN_GET_MY_INFO', {}, integration.user_id);
      console.log('linkedin get_my_info:', JSON.stringify(info));
      if (!info.ok) {
        await ctx.db.query(`UPDATE social_comments SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [commentId, info.error]);
        return json(502, { error: info.error });
      }
      const id = info.data?.id ?? info.data?.sub ?? info.data?.data?.id;
      if (!id) {
        await ctx.db.query(`UPDATE social_comments SET status='failed', error='linkedin: no author id', updated_at=now() WHERE id=$1`, [commentId]);
        return json(502, { error: 'linkedin: no author id returned' });
      }
      urn = `urn:li:person:${id}`;
      await ctx.db.query(
        `UPDATE workspace_integrations
           SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('linkedin_author_urn', $2::text)
         WHERE id = $1`,
        [integration.id, urn],
      );
    }
    console.log('linkedin actor urn:', urn, 'target:', resolvedTargetPostId);

    result = await composio(ctx, 'LINKEDIN_CREATE_COMMENT_ON_POST', {
      actor: urn,
      object: resolvedTargetPostId,
      target_urn: resolvedTargetPostId,
      message: { text: resolvedBody },
    }, integration.user_id);
    console.log('linkedin comment result:', JSON.stringify(result));
  }

  if (!result.ok) {
    await ctx.db.query(
      `UPDATE social_comments SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
      [commentId, (result.error ?? 'unknown_error').slice(0, 1000)],
    );
    return json(502, { error: result.error ?? 'unknown_error' });
  }

  const d = result.data;
  console.log('result data keys:', Object.keys(d ?? {}));

  let externalCommentId: string | null = null;
  let externalUrl: string | null = null;

  if (resolvedChannel === 'reddit') {
    externalCommentId = d?.json?.data?.name ?? d?.data?.name ?? d?.name ?? d?.id ?? null;
    externalUrl = d?.json?.data?.url ?? d?.data?.url ?? d?.url ?? null;
  } else {
    // LinkedIn returns full comment URN in $URN field
    externalCommentId = (d?.['$URN'] as string | null) ?? d?.id ?? null;
    // Link to the post itself (LinkedIn comment permalinks aren't stable)
    externalUrl = `https://www.linkedin.com/feed/update/${resolvedTargetPostId}`;
  }

  await ctx.db.query(
    `UPDATE social_comments
       SET status='sent', external_comment_id=$2, external_url=$3, updated_at=now()
     WHERE id=$1`,
    [commentId, externalCommentId, externalUrl],
  );

  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'social_comment_posted', $3, $4, $5::jsonb)`,
    [
      resolvedWorkspaceId,
      ctx.user.id,
      resolvedEntityType ?? 'social_comment',
      resolvedEntityId ?? commentId,
      JSON.stringify({ channel: resolvedChannel, target_post_id: resolvedTargetPostId, body_preview: resolvedBody.slice(0, 140), external_url: externalUrl }),
    ],
  );

  return json(200, { id: commentId, status: 'sent', external_comment_id: externalCommentId, external_url: externalUrl });
}
