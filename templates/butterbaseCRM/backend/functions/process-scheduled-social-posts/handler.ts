const PER_TICK_CAP = 50;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(_req, ctx) {
  const dueRes = await ctx.db.query(
    `SELECT id FROM social_posts
      WHERE status = 'scheduled' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC
      LIMIT $1`,
    [PER_TICK_CAP],
  );
  const ids = (dueRes.rows ?? []).map(r => r.id);

  // Cron has no end-user; send-social-post derives userId from
  // workspaces.owner_user_id, so we invoke without impersonation.
  const promises = ids.map(post_id =>
    ctx.invoke('send-social-post', { post_id }).catch((e) => {
      console.error(`[process-scheduled-social-posts] dispatch_failed post=${post_id}: ${e?.message ?? e}`);
    }),
  );

  if (typeof ctx.waitUntil === 'function') {
    for (const p of promises) ctx.waitUntil(p);
  }

  return json(200, { ok: true, dispatched: ids.length });
}

