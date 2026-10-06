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
      ORDER BY connected_at ASC LIMIT 1`,
    [workspaceId, toolkit],
  );
  return r.rows?.[0] ?? null;
}

async function resolveLinkedInAuthorUrn(ctx: any, integration: any): Promise<string | null> {
  let urn: string | null = integration.metadata?.linkedin_author_urn ?? null;
  if (urn) return urn;

  const info = await composio(ctx, 'LINKEDIN_GET_MY_INFO', {}, integration.user_id);
  if (!info.ok) return null;
  const id = info.data?.id ?? info.data?.sub ?? info.data?.data?.id;
  if (!id) return null;
  urn = `urn:li:person:${id}`;
  await ctx.db.query(
    `UPDATE workspace_integrations
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('linkedin_author_urn', $2::text)
     WHERE id = $1`,
    [integration.id, urn],
  );
  return urn;
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let input: any;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const { campaign_id, item_ids, final_comments } = input ?? {};
  const commentOverrides: Record<string, string> = final_comments ?? {};

  if (!campaign_id) return json(400, { error: 'campaign_id required' });
  if (!Array.isArray(item_ids) || item_ids.length === 0) return json(400, { error: 'item_ids required (array of item IDs to post)' });

  const campRes = await ctx.db.query(
    `SELECT id, workspace_id, channel, status FROM comment_campaigns WHERE id = $1 LIMIT 1`,
    [campaign_id],
  );
  const campaign = campRes.rows?.[0];
  if (!campaign) return json(404, { error: 'campaign not found' });

  const memCheck = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [campaign.workspace_id, ctx.user.id],
  );
  if (!memCheck.rows?.[0]) return json(403, { error: 'not_a_member' });

  const itemsRes = await ctx.db.query(
    `SELECT id, target_post_id, target_post_url, final_comment
       FROM comment_campaign_items
      WHERE id = ANY($1::uuid[]) AND campaign_id = $2`,
    [item_ids, campaign_id],
  );
  const items = itemsRes.rows;
  if (items.length === 0) return json(404, { error: 'no matching items found' });

  const integration = await resolveWorkspaceIntegration(ctx, campaign.workspace_id, campaign.channel);
  if (!integration) return json(400, { error: `${campaign.channel}: workspace has no connected account` });

  let linkedInAuthorUrn: string | null = null;
  if (campaign.channel === 'linkedin') {
    linkedInAuthorUrn = await resolveLinkedInAuthorUrn(ctx, integration);
    if (!linkedInAuthorUrn) {
      return json(502, { error: 'linkedin: could not resolve author URN' });
    }
  }

  await ctx.db.query(
    `UPDATE comment_campaigns SET status='executing', updated_at=now() WHERE id=$1`,
    [campaign_id],
  );

  const results: { id: string; status: 'sent' | 'failed'; error?: string; social_comment_id?: string }[] = [];

  for (const item of items) {
    const body = commentOverrides[item.id] ?? item.final_comment;
    if (!body || !body.trim()) {
      await ctx.db.query(`UPDATE comment_campaign_items SET status='failed', updated_at=now() WHERE id=$1`, [item.id]);
      results.push({ id: item.id, status: 'failed', error: 'empty comment body' });
      continue;
    }

    const scRes = await ctx.db.query(
      `INSERT INTO social_comments
         (workspace_id, created_by, channel, target_post_id, target_post_url, body, status, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'comment_campaign_item', $7)
       RETURNING id`,
      [campaign.workspace_id, ctx.user.id, campaign.channel, item.target_post_id, item.target_post_url ?? null, body, item.id],
    );
    const socialCommentId = scRes.rows[0].id;

    let result: { ok: boolean; data?: any; error?: string };

    if (campaign.channel === 'reddit') {
      result = await composio(ctx, 'REDDIT_POST_REDDIT_COMMENT', {
        thing_id: item.target_post_id,
        text: body,
      }, integration.user_id);
    } else if (campaign.channel === 'twitter') {
      result = await composio(ctx, 'TWITTER_CREATION_OF_A_POST', {
        text: body,
        reply_in_reply_to_tweet_id: item.target_post_id,
      }, integration.user_id);
    } else {
      // LinkedIn
      result = await composio(ctx, 'LINKEDIN_CREATE_COMMENT_ON_POST', {
        actor: linkedInAuthorUrn,
        object: item.target_post_id,
        target_urn: item.target_post_id,
        message: { text: body },
      }, integration.user_id);
    }

    if (!result.ok) {
      await ctx.db.query(
        `UPDATE social_comments SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
        [socialCommentId, (result.error ?? 'unknown_error').slice(0, 1000)],
      );
      await ctx.db.query(
        `UPDATE comment_campaign_items SET status='failed', social_comment_id=$2, updated_at=now() WHERE id=$1`,
        [item.id, socialCommentId],
      );
      results.push({ id: item.id, status: 'failed', error: result.error, social_comment_id: socialCommentId });
      continue;
    }

    const d = result.data;
    let externalCommentId: string | null;
    let externalUrl: string | null;

    if (campaign.channel === 'reddit') {
      externalCommentId = d?.json?.data?.name ?? d?.data?.name ?? d?.name ?? d?.id ?? null;
      externalUrl = d?.json?.data?.url ?? d?.data?.url ?? d?.url ?? null;
    } else if (campaign.channel === 'twitter') {
      externalCommentId = d?.data?.id ?? d?.id ?? null;
      externalUrl = externalCommentId ? `https://x.com/i/status/${externalCommentId}` : null;
    } else {
      externalCommentId = (d?.['$URN'] as string | null) ?? d?.id ?? null;
      externalUrl = `https://www.linkedin.com/feed/update/${item.target_post_id}`;
    }

    await ctx.db.query(
      `UPDATE social_comments SET status='sent', external_comment_id=$2, external_url=$3, updated_at=now() WHERE id=$1`,
      [socialCommentId, externalCommentId, externalUrl],
    );
    await ctx.db.query(
      `UPDATE comment_campaign_items SET status='posted', social_comment_id=$2, updated_at=now() WHERE id=$1`,
      [item.id, socialCommentId],
    );
    await ctx.db.query(
      `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
       VALUES ($1, $2, 'social_comment_posted', 'comment_campaign_item', $3, $4::jsonb)`,
      [campaign.workspace_id, ctx.user.id, item.id,
        JSON.stringify({ campaign_id, channel: campaign.channel, target_post_id: item.target_post_id, body_preview: body.slice(0, 140), external_url: externalUrl })],
    );

    results.push({ id: item.id, status: 'sent', social_comment_id: socialCommentId });
  }

  const postedCount = results.filter((r) => r.status === 'sent').length;
  await ctx.db.query(
    `UPDATE comment_campaigns
       SET posted_count = posted_count + $2,
           status = CASE WHEN posted_count + $2 >= item_count THEN 'completed' ELSE 'ready' END,
           updated_at = now()
     WHERE id = $1`,
    [campaign_id, postedCount],
  );

  return json(200, { campaign_id, results, posted: postedCount, failed: results.length - postedCount });
}
