// HTTP: post a reply to a Reddit inbox item and stamp replied_at.

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
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let input: any;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  const { inbox_item_id, body } = input ?? {};
  if (!inbox_item_id) return json(400, { error: 'inbox_item_id required' });
  if (!body || typeof body !== 'string' || !body.trim()) return json(400, { error: 'body required' });

  const itemRes = await ctx.db.query(
    `SELECT ri.id, ri.workspace_id, ri.channel, ri.external_reply_id, ri.replied_at
     FROM social_reply_inbox ri
     WHERE ri.id = $1 LIMIT 1`,
    [inbox_item_id],
  );
  const item = itemRes.rows[0];
  if (!item) return json(404, { error: 'inbox_item not found' });

  const memCheck = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [item.workspace_id, ctx.user.id],
  );
  if (!memCheck.rows?.[0]) return json(403, { error: 'not_a_member' });

  if (item.replied_at) return json(409, { error: 'already_replied' });

  const intRes = await ctx.db.query(
    `SELECT user_id FROM workspace_integrations
     WHERE workspace_id = $1 AND toolkit_slug = $2 LIMIT 1`,
    [item.workspace_id, item.channel],
  );
  const userId: string | null = intRes.rows[0]?.user_id ?? null;
  if (!userId) return json(400, { error: `${item.channel}: no connected account` });

  if (item.channel === 'reddit') {
    const thingId: string = item.external_reply_id.startsWith('t')
      ? item.external_reply_id
      : `t1_${item.external_reply_id}`;

    const result = await composio(ctx, 'REDDIT_POST_REDDIT_COMMENT', {
      thing_id: thingId,
      text: body.trim(),
    }, userId);

    if (!result.ok) return json(502, { error: result.error });

    const d = result.data;
    const newThingId: string =
      d?.json?.data?.things?.[0]?.data?.name ??
      d?.data?.name ??
      d?.name ?? null;

    await ctx.db.query(
      `UPDATE social_reply_inbox SET replied_at = now() WHERE id = $1`,
      [inbox_item_id],
    );

    return json(200, { ok: true, external_reply_id: newThingId });
  }

  return json(400, { error: `channel ${item.channel} not supported` });
}

