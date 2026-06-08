export default async function handler(
  req: Request,
  ctx: { db: { query: (sql: string, args: unknown[]) => Promise<{ rows: unknown[] }> } },
): Promise<Response> {
  const { email } = await req.json();
  if (!email) {
    return Response.json({ error: 'email required' }, { status: 400 });
  }
  const { rows } = await ctx.db.query(
    'SELECT id, plan, status FROM accounts WHERE email = $1 LIMIT 1',
    [email],
  );
  return Response.json(rows[0] ?? { error: 'not_found' });
}
