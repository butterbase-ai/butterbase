export default async function handler(_req, ctx) {
  const r = await ctx.db.query(
    `UPDATE agent_proposals
        SET status = 'expired', resolved_at = now()
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id`,
  );
  console.log(`agent-proposals-expire: expired ${r.rows.length} rows`);
  return new Response(JSON.stringify({ expired: r.rows.length }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
