export default async function handler(_req, ctx) {
  let deleted = 0;
  try {
    const r = await ctx.db.query("DELETE FROM _idempotency_keys WHERE expires_at < now() RETURNING key");
    deleted = r.rows.length;
  } catch (err) {
    console.error("cleanup-idempotency-keys: error", err?.message);
    return new Response(JSON.stringify({ ok: false, error: err?.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
  console.info(`cleanup-idempotency-keys: ${deleted} keys removed`);
  return new Response(JSON.stringify({ ok: true, deleted }), {
    headers: { "Content-Type": "application/json" }
  });
}

