export default async function handler(req, ctx) {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" }
    });
  }

  // Admin check (defense-in-depth; RLS also enforces)
  const adm = await ctx.db.query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner','admin')",
    [ctx.user.id]
  );
  if (adm.rows.length === 0) {
    return new Response(JSON.stringify({ error: "forbidden", reason: "admin_only" }), {
      status: 403, headers: { "Content-Type": "application/json" }
    });
  }

  // Generate cryptographically random secret: ws_<64 hex chars>
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  const secret = `ws_${hex}`;

  // Upsert singleton
  try {
    await ctx.db.query(
      `INSERT INTO widget_secrets (singleton, secret, created_by, created_at, rotated_at)
       VALUES (true, $1, $2, now(), NULL)
       ON CONFLICT (singleton) DO UPDATE
       SET secret = EXCLUDED.secret, rotated_at = now(), created_by = EXCLUDED.created_by`,
      [secret, ctx.user.id]
    );
  } catch (err) {
    console.error("rotate-widget-secret: db error", err?.message);
    return new Response(JSON.stringify({ error: "db_error", message: err?.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'widget_secret_rotated', 'system', 'widget_secret', $2)`,
    [ctx.user.id, JSON.stringify({ at: new Date().toISOString() })]
  );

  return new Response(JSON.stringify({
    secret,
    warning: "This value is shown ONCE. Store it server-side in your app. We cannot retrieve it again."
  }), {
    headers: { "Content-Type": "application/json" }
  });
}

