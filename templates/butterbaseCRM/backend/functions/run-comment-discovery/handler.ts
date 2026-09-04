// Cron-driven Reddit comment discovery: searches for posts mentioning workspace
// competitors, AI-verifies relevance, and queues comment drafts for review.

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

async function aiComplete(ctx: any, prompt: string, maxTokens = 350): Promise<string> {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.AI_SERVICE_KEY}` },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });
  if (!res.ok) return '';
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? '';
}

async function alreadyQueued(ctx: any, workspaceId: string, postId: string): Promise<boolean> {
  const r = await ctx.db.query(
    `SELECT 1 FROM comment_campaign_items
     WHERE workspace_id = $1 AND target_post_id = $2
       AND created_at > now() - interval '7 days' LIMIT 1`,
    [workspaceId, postId],
  );
  return r.rows.length > 0;
}

interface DiscoveredItem {
  target_post_id: string;
  target_post_url: string | null;
  target_post_title: string;
  draft: string;
}

async function discoverRedditForCompetitor(
  ctx: any,
  workspaceId: string,
  competitor: { name: string; description: string | null; keywords: string | null },
  integration: { user_id: string },
): Promise<DiscoveredItem[]> {
  const query = `${competitor.name}${competitor.keywords ? ` ${competitor.keywords}` : ''}`.trim();
  const result = await composio(ctx, 'REDDIT_SEARCH_ACROSS_SUBREDDITS', {
    search_query: query,
    sort: 'new',
    limit: 5,
    restrict_sr: false,
  }, integration.user_id);
  if (!result.ok) return [];

  const d = result.data;
  const raw: any[] = d?.posts ?? d?.data?.children ?? d?.children ?? [];
  const posts = raw.map((c: any) => c.data ?? c).filter((p: any) => p.id || p.name).slice(0, 5);

  const items: DiscoveredItem[] = [];
  for (const post of posts) {
    const thingId: string = post.name ?? `t3_${post.id}`;
    if (await alreadyQueued(ctx, workspaceId, thingId)) continue;

    const postUrl: string = post.permalink
      ? (post.permalink.startsWith('http') ? post.permalink : `https://www.reddit.com${post.permalink}`)
      : `https://www.reddit.com/comments/${post.id ?? thingId.replace('t3_', '')}`;
    const postTitle: string = post.title ?? thingId;
    const postBody: string = post.selftext ? String(post.selftext).slice(0, 400) : '';

    const prompt = `Competitor "${competitor.name}"${competitor.description ? ` (${competitor.description})` : ''} is being monitored for engagement opportunities.

Reddit post:
Title: ${postTitle}${postBody ? `\nContent: ${postBody}` : ''}

If this post is relevant to "${competitor.name}" or the problems they solve, write a helpful, genuine 2-3 sentence Reddit comment that adds value. Do not be promotional.
If NOT relevant, reply with exactly: NOT_RELEVANT

Reply:`;

    const draft = await aiComplete(ctx, prompt, 300);
    if (!draft || draft.trim().toUpperCase() === 'NOT_RELEVANT') continue;

    items.push({ target_post_id: thingId, target_post_url: postUrl, target_post_title: postTitle, draft });
  }
  return items;
}

async function createDiscoveryCampaign(
  ctx: any,
  workspaceId: string,
  ownerId: string,
  channel: 'reddit',
  runDate: string,
  items: DiscoveredItem[],
) {
  const campaignRes = await ctx.db.query(
    `INSERT INTO comment_campaigns
       (workspace_id, created_by, name, channel, targeting_spec, status)
     VALUES ($1, $2, $3, $4, $5, 'ready') RETURNING id`,
    [workspaceId, ownerId, `Auto ${channel} – ${runDate}`, channel, JSON.stringify({ auto_discovery: true })],
  );
  const campaignId: string = campaignRes.rows[0].id;

  await Promise.all(items.map((item) =>
    ctx.db.query(
      `INSERT INTO comment_campaign_items
         (campaign_id, workspace_id, target_post_id, target_post_url, target_post_title, generated_comment, final_comment, status)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 'pending')`,
      [campaignId, workspaceId, item.target_post_id, item.target_post_url, item.target_post_title, item.draft],
    ),
  ));

  await ctx.db.query(
    `UPDATE comment_campaigns SET item_count = $2, updated_at = now() WHERE id = $1`,
    [campaignId, items.length],
  );
}

export async function handler(req: Request, ctx: any) {
  const wsRes = await ctx.db.query(`SELECT DISTINCT workspace_id FROM workspace_competitors`);
  const workspaceIds: string[] = wsRes.rows.map((r: any) => r.workspace_id);

  const runDate = new Date().toISOString().slice(0, 10);
  const summary = { workspaces: 0, reddit_items: 0, errors: [] as string[] };

  for (const workspaceId of workspaceIds) {
    try {
      const ownerRes = await ctx.db.query(
        `SELECT user_id FROM memberships WHERE workspace_id = $1 AND role = 'owner' LIMIT 1`,
        [workspaceId],
      );
      const ownerId: string | null = ownerRes.rows[0]?.user_id ?? null;
      if (!ownerId) continue;

      const compRes = await ctx.db.query(
        `SELECT name, description, keywords FROM workspace_competitors WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (!compRes.rows.length) continue;

      const intRes = await ctx.db.query(
        `SELECT toolkit_slug, user_id FROM workspace_integrations
         WHERE workspace_id = $1 AND toolkit_slug = 'reddit'`,
        [workspaceId],
      );
      const redditIntegration = intRes.rows[0] ?? null;

      const redditItems: DiscoveredItem[] = [];

      if (redditIntegration) {
        for (const comp of compRes.rows) {
          const found = await discoverRedditForCompetitor(ctx, workspaceId, comp, redditIntegration);
          redditItems.push(...found);
        }
      }

      if (redditItems.length > 0) {
        await createDiscoveryCampaign(ctx, workspaceId, ownerId, 'reddit', runDate, redditItems);
        summary.reddit_items += redditItems.length;
      }

      summary.workspaces++;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      console.error(`[run-comment-discovery] ws ${workspaceId}:`, msg);
      summary.errors.push(`ws ${workspaceId}: ${msg}`);
    }
  }

  console.log('[run-comment-discovery] done', JSON.stringify(summary));
  return json(200, summary);
}
