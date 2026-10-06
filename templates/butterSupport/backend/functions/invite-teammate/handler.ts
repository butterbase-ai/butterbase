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
  const { email, entry_type, value, default_role, note, send_email } = body || {};

  // Accept either {email} or {entry_type, value}
  const eType = entry_type || (email ? "email" : null);
  const eValue = (value || email || "").toLowerCase().trim();
  if (!eType || !eValue) return json({ error: "missing_email_or_value" }, 400);
  if (!["email", "domain"].includes(eType)) return json({ error: "invalid_entry_type" }, 400);
  const role = ["owner", "admin", "member"].includes(default_role) ? default_role : "member";

  const ins = await ctx.db.query(
    `INSERT INTO app_allowlist (entry_type, value, active, default_role, note, created_by)
     VALUES ($1, $2, true, $3, $4, $5)
     ON CONFLICT (entry_type, value) DO UPDATE
       SET active = true, default_role = EXCLUDED.default_role, note = COALESCE(EXCLUDED.note, app_allowlist.note), updated_at = now()
     RETURNING id, entry_type, value, default_role, active`,
    [eType, eValue, role, note || null, ctx.user.id]
  );

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'allowlist.added', 'app_allowlist', $2::text, $3)`,
    [ctx.user.id, ins.rows[0].id, JSON.stringify({ entry_type: eType, value: eValue, role })]
  );

  // Best-effort invite email via Composio Gmail (only for email entries)
  let emailSent = null;
  if (send_email && eType === "email") {
    ctx.waitUntil((async () => {
      try {
        const inviterEmail = await ctx.db.query("SELECT invited_email FROM memberships WHERE user_id = $1", [ctx.user.id]);
        await ctx.integrations.asUser(ctx.user.id).execute("GMAIL_SEND_EMAIL", {
          to: eValue,
          subject: "You've been invited to support",
          body: `Hi,\n\n${inviterEmail.rows[0]?.invited_email || "Your colleague"} has invited you to the support team.\n\nSign in with magic link using this email address.\n\n`
        });
      } catch (err) {
        console.warn("invite-teammate: gmail send failed (Composio not connected?)", err?.message);
      }
    })());
    emailSent = "queued";
  }

  return json({ ok: true, allowlist: ins.rows[0], email_dispatch: emailSent });
}

