function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { user_id, remove_from_allowlist } = body || {};
  if (!user_id) return json({ error: "missing_user_id" }, 400);

  const isSelf = user_id === ctx.user.id;
  if (!isSelf) {
    const adm = await ctx.db.query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner','admin')",
      [ctx.user.id]
    );
    if (adm.rows.length === 0) return json({ error: "forbidden", reason: "admin_or_self_only" }, 403);
  }

  // Prevent removing the last owner
  const ownerCount = await ctx.db.query("SELECT count(*)::int AS n FROM memberships WHERE role = 'owner'");
  const target = await ctx.db.query("SELECT role, invited_email FROM memberships WHERE user_id = $1", [user_id]);
  if (target.rows.length === 0) return json({ error: "not_a_member" }, 404);
  if (target.rows[0].role === "owner" && ownerCount.rows[0].n <= 1) {
    return json({ error: "cannot_remove_last_owner" }, 409);
  }

  const removedEmail = target.rows[0].invited_email;

  await ctx.db.query("DELETE FROM memberships WHERE user_id = $1", [user_id]);

  if (remove_from_allowlist && removedEmail) {
    await ctx.db.query(
      "DELETE FROM app_allowlist WHERE entry_type = 'email' AND value = $1",
      [removedEmail.toLowerCase()]
    );
  }

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'member.removed', 'memberships', $2::text, $3)`,
    [ctx.user.id, user_id, JSON.stringify({ self: isSelf, email_removed: !!remove_from_allowlist, removed_email: removedEmail })]
  );

  return json({ ok: true, removed_user_id: user_id, allowlist_cleared: !!remove_from_allowlist });
}

