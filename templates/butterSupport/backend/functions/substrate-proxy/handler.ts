function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const READ_ACTIONS = new Set([
  "findEntities", "getEntity",
  "searchMemory",
  "listSourceArtifacts", "getSourceArtifact",
  "listActions", "getAction",
  "snapshots", "getSettings"
]);

const HARD_LIMIT = 100;

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  // Any team member can read.
  const m = await ctx.db.query("SELECT 1 FROM memberships WHERE user_id = $1", [ctx.user.id]);
  if (m.rows.length === 0) return json({ error: "forbidden", reason: "not_a_member" }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { action, params } = body || {};
  if (!action) return json({ error: "missing_action" }, 400);
  if (!READ_ACTIONS.has(action)) {
    return json({ error: "action_not_allowed", allowed: Array.from(READ_ACTIONS) }, 403);
  }

  // Clamp limit
  const safeParams = { ...(params || {}) };
  if (typeof safeParams.limit === "number") safeParams.limit = Math.min(safeParams.limit, HARD_LIMIT);
  else if (action === "findEntities" || action === "searchMemory" || action === "listSourceArtifacts" || action === "listActions") {
    safeParams.limit = HARD_LIMIT;
  }

  try {
    let result;
    switch (action) {
      case "findEntities":      result = await ctx.substrate.findEntities(safeParams); break;
      case "getEntity":         result = await ctx.substrate.getEntity(safeParams.entity_id || safeParams.id); break;
      case "searchMemory":      result = await ctx.substrate.searchMemory(safeParams.query || safeParams.q, safeParams); break;
      case "listSourceArtifacts": result = await ctx.substrate.listSourceArtifacts(safeParams); break;
      case "getSourceArtifact": result = await ctx.substrate.getSourceArtifact(safeParams.artifact_id || safeParams.id); break;
      case "listActions":       result = await ctx.substrate.listActions(safeParams); break;
      case "getAction":         result = await ctx.substrate.getAction(safeParams.action_id || safeParams.id); break;
      case "snapshots":         result = await ctx.substrate.snapshots(safeParams); break;
      case "getSettings":       result = await ctx.substrate.getSettings(); break;
    }
    return json({ ok: true, data: result });
  } catch (err) {
    console.error("substrate-proxy: substrate call failed", action, err?.message);
    return json({ error: "substrate_call_failed", action, message: err?.message }, 502);
  }
}

