// Accepts targeting criteria for Reddit (keywords/subreddits), Twitter (tweet URLs/IDs),
// or LinkedIn (post URLs); generates AI draft comments and stores them as campaign items.

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function resolveWorkspaceIntegration(ctx: any, workspaceId: string, toolkit: string) {
  const r = await ctx.db.query(
    `SELECT id, user_id FROM workspace_integrations
      WHERE workspace_id = $1 AND toolkit_slug = $2
      ORDER BY connected_at ASC LIMIT 1`,
    [workspaceId, toolkit],
  );
  return r.rows?.[0] ?? null;
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
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.log('aiComplete failed', res.status, errText.slice(0, 300));
    return '';
  }
  const data = await res.json();
  const result = data?.choices?.[0]?.message?.content?.trim() ?? '';
  console.log('aiComplete ok, length:', result.length, 'preview:', result.slice(0, 80));
  return result;
}

function parseLinkedInUrl(raw: string): { urn: string; postUrl?: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const urnMatch = trimmed.match(/(urn:li:[^/?\s&]+)/i);
  if (urnMatch) {
    if (/^urn:li:activity:/i.test(urnMatch[1])) return null;
    return { urn: urnMatch[1] };
  }
  const feedMatch = trimmed.match(/feed\/update\/(urn[^/?#\s&]+)/i);
  if (feedMatch) return { urn: decodeURIComponent(feedMatch[1]), postUrl: trimmed };
  const ugcMatch = trimmed.match(/\/posts\/[^/?#]*-ugcPost-(\d+)/i);
  if (ugcMatch) return { urn: `urn:li:ugcPost:${ugcMatch[1]}`, postUrl: trimmed };
  const shareMatch = trimmed.match(/\/posts\/[^/?#]*-share-(\d+)/i);
  if (shareMatch) return { urn: `urn:li:share:${shareMatch[1]}`, postUrl: trimmed };
  if (trimmed.match(/\/posts\/[^/?#]*-activity-(\d+)/i)) return null;

  return null;
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let input: any;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const { workspace_id, name, channel, targeting_spec } = input ?? {};

  if (!workspace_id) return json(400, { error: 'workspace_id required' });
  if (!name || typeof name !== 'string') return json(400, { error: 'name required' });
  if (channel !== 'reddit' && channel !== 'linkedin' && channel !== 'twitter') return json(400, { error: 'channel must be reddit, linkedin, or twitter' });

  const memCheck = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspace_id, ctx.user.id],
  );
  if (!memCheck.rows?.[0]) return json(403, { error: 'not_a_member' });

  const integration = await resolveWorkspaceIntegration(ctx, workspace_id, channel);
  if (!integration) return json(400, { error: `${channel}: workspace has no connected account` });

  const persona = targeting_spec?.persona_instructions ?? 'You are a helpful professional.';
  const tone = targeting_spec?.tone ?? 'professional and genuine';
  const limit = Math.min(targeting_spec?.limit ?? 10, 25);

  const campaignRes = await ctx.db.query(
    `INSERT INTO comment_campaigns
       (workspace_id, created_by, name, channel, targeting_spec, status)
     VALUES ($1, $2, $3, $4, $5, 'discovering')
     RETURNING id`,
    [workspace_id, ctx.user.id, name, channel, JSON.stringify(targeting_spec ?? {})],
  );
  const campaignId = campaignRes.rows[0].id;

  const insertedItems: { id: string; target_post_id: string; title: string; draft: string }[] = [];

  if (channel === 'reddit') {
    const keywords: string = targeting_spec?.keywords ?? '';
    const subreddits: string[] = targeting_spec?.subreddits ?? [];
    const sort: string = targeting_spec?.sort ?? 'relevance';

    let searchQuery = keywords.trim();
    if (subreddits.length > 0) {
      const cleaned = subreddits.map((s: string) => s.trim().replace(/^r\//, '').replace(/\s+/g, '')).filter(Boolean);
      if (cleaned.length === 1) {
        searchQuery = `subreddit:${cleaned[0]} ${searchQuery}`.trim();
      } else if (cleaned.length > 1) {
        searchQuery = `(${cleaned.map((s: string) => `subreddit:${s}`).join(' OR ')}) ${searchQuery}`.trim();
      }
    }

    if (!searchQuery) {
      await ctx.db.query(`UPDATE comment_campaigns SET status='failed', updated_at=now() WHERE id=$1`, [campaignId]);
      return json(400, { error: 'keywords or subreddits required for Reddit discovery' });
    }

    const searchResult = await composio(ctx, 'REDDIT_SEARCH_ACROSS_SUBREDDITS', {
      search_query: searchQuery,
      sort,
      limit,
      restrict_sr: false,
    }, integration.user_id);

    if (!searchResult.ok) {
      await ctx.db.query(`UPDATE comment_campaigns SET status='failed', updated_at=now() WHERE id=$1`, [campaignId]);
      return json(502, { error: `reddit search failed: ${searchResult.error}` });
    }

    const d = searchResult.data;
    const raw: any[] = d?.posts ?? d?.data?.children ?? d?.children ?? [];
    const posts = raw
      .map((c: any) => c.data ?? c)
      .filter((p: any) => p.id || p.name)
      .slice(0, limit);

    await Promise.all(posts.map(async (post: any) => {
      const thingId: string = post.name ?? `t3_${post.id}`;
      const rawId: string = post.id ?? thingId.replace('t3_', '');
      const postUrl: string = post.permalink
        ? (post.permalink.startsWith('http') ? post.permalink : `https://www.reddit.com${post.permalink}`)
        : `https://www.reddit.com/comments/${rawId}`;
      const postTitle: string = post.title ?? thingId;
      const postBody: string = post.selftext ? (post.selftext as string).slice(0, 500) : '';

      const prompt = `${persona}

Write a Reddit comment for this post:
Title: ${postTitle}${postBody ? `\nPost content: ${postBody}` : ''}
URL: ${postUrl}

Tone: ${tone}. Be genuine and add value. Do NOT be promotional. 2-4 sentences. Reply with only the comment text, no preamble.

Your comment:`;
      const draft = await aiComplete(ctx, prompt);

      const itemRes = await ctx.db.query(
        `INSERT INTO comment_campaign_items
           (campaign_id, workspace_id, target_post_id, target_post_url, target_post_title, generated_comment, final_comment, status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'pending')
         RETURNING id`,
        [campaignId, workspace_id, thingId, postUrl, postTitle, draft],
      );
      insertedItems.push({ id: itemRes.rows[0].id, target_post_id: thingId, title: postTitle, draft });
    }));

  } else if (channel === 'twitter') {
    const postUrls: string[] = targeting_spec?.post_urls ?? [];
    if (postUrls.length === 0) {
      await ctx.db.query(`UPDATE comment_campaigns SET status='failed', updated_at=now() WHERE id=$1`, [campaignId]);
      return json(400, { error: 'targeting_spec.post_urls required for Twitter' });
    }

    const tweetEntries: { id: string; url: string }[] = [];
    for (const raw of postUrls.slice(0, 25)) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const urlMatch = trimmed.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
      if (urlMatch) { tweetEntries.push({ id: urlMatch[1], url: trimmed }); continue; }
      if (/^\d+$/.test(trimmed)) { tweetEntries.push({ id: trimmed, url: `https://x.com/i/status/${trimmed}` }); continue; }
    }

    if (tweetEntries.length === 0) {
      await ctx.db.query(`UPDATE comment_campaigns SET status='failed', updated_at=now() WHERE id=$1`, [campaignId]);
      return json(400, { error: 'No valid tweet URLs or IDs provided' });
    }

    await Promise.all(tweetEntries.map(async ({ id, url }) => {
      const tweetUrl = url.startsWith('http') ? url : `https://x.com/i/status/${id}`;

      const prompt = `${persona}

Write a reply to the X (Twitter) post at ${tweetUrl}.
Tone: ${tone}. Be genuine, add real value, and spark engagement. Do NOT be promotional. Keep it under 280 characters. Reply with only the reply text, no preamble.

Your reply:`;
      const draft = await aiComplete(ctx, prompt, 150);

      const itemRes = await ctx.db.query(
        `INSERT INTO comment_campaign_items
           (campaign_id, workspace_id, target_post_id, target_post_url, target_post_title, generated_comment, final_comment, status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'pending')
         RETURNING id`,
        [campaignId, workspace_id, id, tweetUrl, id, draft],
      );
      insertedItems.push({ id: itemRes.rows[0].id, target_post_id: id, title: id, draft });
    }));

  } else {
    // LinkedIn: accept post URLs, fetch content for better AI context
    const postUrls: string[] = targeting_spec?.post_urls ?? [];
    if (postUrls.length === 0) {
      await ctx.db.query(`UPDATE comment_campaigns SET status='failed', updated_at=now() WHERE id=$1`, [campaignId]);
      return json(400, { error: 'targeting_spec.post_urls required for LinkedIn' });
    }

    const entries = postUrls.slice(0, 25).map(parseLinkedInUrl).filter(Boolean) as { urn: string; postUrl?: string }[];

    await Promise.all(entries.map(async ({ urn, postUrl }) => {
      let postContent = '';
      const contentResult = await composio(ctx, 'LINKEDIN_GET_POST_CONTENT', { post_id: urn }, integration.user_id);
      if (contentResult.ok) {
        const cd = contentResult.data;
        const raw: string =
          cd?.commentary?.text ??
          cd?.specificContent?.['com.linkedin.ugc.ShareContent']?.shareCommentary?.text ??
          cd?.text ?? '';
        postContent = raw.slice(0, 500);
      }

      const prompt = `${persona}

Write a LinkedIn comment for this post${postContent ? `:\n"${postContent}"` : ` (ID: ${urn})`}.
Tone: ${tone}. Be insightful and professional. Add genuine value. Do NOT be overly promotional. 2-3 sentences. Reply with only the comment text, no preamble.

Your comment:`;
      const draft = await aiComplete(ctx, prompt);

      const itemRes = await ctx.db.query(
        `INSERT INTO comment_campaign_items
           (campaign_id, workspace_id, target_post_id, target_post_url, target_post_title, generated_comment, final_comment, status)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'pending')
         RETURNING id`,
        [campaignId, workspace_id, urn, postUrl ?? null, urn, draft],
      );
      insertedItems.push({ id: itemRes.rows[0].id, target_post_id: urn, title: urn, draft });
    }));
  }

  await ctx.db.query(
    `UPDATE comment_campaigns SET status='ready', item_count=$2, updated_at=now() WHERE id=$1`,
    [campaignId, insertedItems.length],
  );

  return json(200, {
    campaign_id: campaignId,
    item_count: insertedItems.length,
    items: insertedItems,
  });
}
