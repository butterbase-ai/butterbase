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

  const reqUrl = new URL(req.url);
  const startDate = reqUrl.searchParams.get("startDate");
  const endDate = reqUrl.searchParams.get("endDate");

  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const qs = params.toString();

  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/ai/usage${qs ? `?${qs}` : ""}`;
  const r = await fetch(url, {
    headers: { "Authorization": `Bearer ${ctx.env.BUTTERBASE_API_KEY}` }
  });
  if (!r.ok) {
    return json({ error: "ai_usage_api_error", status: r.status, message: await r.text() }, 502);
  }
  const data = await r.json();
  return json(data);
}

