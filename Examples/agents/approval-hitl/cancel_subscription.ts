export default async function handler(
  req: Request,
  ctx: { db: { query: (sql: string, args: unknown[]) => Promise<{ rowCount: number }> } },
): Promise<Response> {
  const { user_id } = await req.json();
  if (!user_id) {
    return Response.json({ error: 'user_id required' }, { status: 400 });
  }
  const r = await ctx.db.query(
    `UPDATE subscriptions
       SET status = 'cancelled', cancelled_at = now()
     WHERE user_id = $1 AND status != 'cancelled'`,
    [user_id],
  );
  return Response.json({ cancelled: r.rowCount > 0, user_id });
}
