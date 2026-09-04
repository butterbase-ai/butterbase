// Cron: fetch top-level replies on Reddit posts we've sent and upsert into social_reply_inbox.

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

export async function handler(req: Request, ctx: any) {
  const sendsRes = await ctx.db.query(
    `SELECT sps.id AS send_id, sps.workspace_id, sps.external_post_id
     FROM social_post_sends sps
     WHERE sps.channel = 'reddit'
       AND sps.status = 'sent'
       AND sps.external_post_id IS NOT NULL
       AND sps.sent_at > now() - interval '30 days'`,
  );

  const summary = { sends_checked: 0, replies_upserted: 0, errors: [] as string[] };

  for (const send of sendsRes.rows) {
    const { send_id, workspace_id, external_post_id } = send;

    const intRes = await ctx.db.query(
      `SELECT user_id FROM workspace_integrations
       WHERE workspace_id = $1 AND toolkit_slug = 'reddit' LIMIT 1`,
      [workspace_id],
    );
    const userId: string | null = intRes.rows[0]?.user_id ?? null;
    if (!userId) continue;

    const article: string = String(external_post_id).replace(/^t3_/, '');

    try {
      const result = await composio(ctx, 'REDDIT_RETRIEVE_POST_COMMENTS', {
        article,
        sort: 'new',
        limit: 25,
        depth: 1,
      }, userId);

      if (!result.ok) {
        summary.errors.push(`send ${send_id}: ${result.error}`);
        continue;
      }

      // Composio returns { comments_listing: { data: { children: [...] } }, post_listing: {...} }
      const d = result.data;
      const children: any[] =
        d?.comments_listing?.data?.children ??
        d?.listings?.[1]?.data?.children ??
        d?.listings?.[0]?.data?.children ??
        d?.children ??
        [];

      for (const child of children) {
        const c = child.data ?? child;
        if (!c || child.kind === 'more' || c.kind === 'more') continue;
        const thingId: string = c.name ?? `t1_${c.id}`;
        if (!c.id && !c.name) continue;

        const body: string = c.body ?? c.selftext ?? '';
        if (!body) continue;

        const postPermalink: string = c.permalink
          ? (c.permalink.startsWith('http') ? c.permalink : `https://www.reddit.com${c.permalink}`)
          : '';

        await ctx.db.query(
          `INSERT INTO social_reply_inbox
             (workspace_id, send_id, channel, external_reply_id, external_post_id, author_name, body, score, external_url, fetched_at)
           VALUES ($1, $2, 'reddit', $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (workspace_id, channel, external_reply_id) DO UPDATE
             SET body = EXCLUDED.body,
                 score = EXCLUDED.score,
                 fetched_at = now()`,
          [workspace_id, send_id, thingId, external_post_id, c.author ?? null, body.slice(0, 5000), c.score ?? 0, postPermalink || null],
        );
        summary.replies_upserted++;
      }

      summary.sends_checked++;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      console.error(`[fetch-post-replies] send ${send_id}:`, msg);
      summary.errors.push(`send ${send_id}: ${msg}`);
    }
  }

  console.log('[fetch-post-replies] done', JSON.stringify(summary));
  return json(200, summary);
}

