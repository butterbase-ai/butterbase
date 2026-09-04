function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  const adm = await ctx.db.query(
    "SELECT 1 FROM memberships WHERE user_id = $1 AND role IN ('owner','admin')",
    [ctx.user.id]
  );
  if (adm.rows.length === 0) return json({ error: "forbidden", reason: "admin_only" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { title, content, scope, rationale, source_ticket_id } = body || {};
  if (!title || !content) return json({ error: "missing_fields" }, 400);

  // record_decision schema fields: title, kind, rationale?, salience?, source_artifact_id?
  // `content` is NOT a valid field — fold it into rationale.
  // Valid kinds: operational | strategic | mission | vision | principle | policy_decision
  const combinedRationale = [
    rationale ? rationale.trim() : null,
    content ? `Policy text:\n${content.trim()}` : null,
    scope ? `Scope: ${scope}` : null,
    source_ticket_id ? `Source ticket: ${source_ticket_id}` : null,
  ].filter(Boolean).join('\n\n');

  let substrateResult = null;
  try {
    substrateResult = await ctx.substrate.propose("record_decision", {
      title: String(title).slice(0, 200),
      kind: "policy_decision",
      rationale: combinedRationale || undefined,
    }, source_ticket_id ? { idempotency_key: `policy:${source_ticket_id}:${title}`.slice(0, 200) } : undefined);
  } catch (err) {
    console.error("convert-to-policy: substrate.propose failed", err?.message);
    return json({ error: "substrate_propose_failed", message: err?.message }, 502);
  }

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'policy.created', 'substrate_decision', $2, $3)`,
    [ctx.user.id, substrateResult?.action_id || "unknown", JSON.stringify({ title, scope, source_ticket_id, substrate_action_id: substrateResult?.action_id })]
  );

  return json({ ok: true, substrate: substrateResult });
}

