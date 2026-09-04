export default async function handler(req, ctx) {
  let body;
  try {
    body = await req.json();
  } catch (err) {
    console.error("auth-bootstrap-hook: invalid JSON body", err?.message);
    return new Response(JSON.stringify({ ok: false, reason: "invalid_json" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { event, user, isNewUser, provider } = body || {};
    if (!user || !user.id || !user.email) {
      return new Response(JSON.stringify({ ok: true, reason: "missing_user" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const userId = user.id;
    const email = String(user.email).toLowerCase();
    const domain = email.includes("@") ? email.split("@")[1] : "";

    // Fast path: user already a member -> log login and bail.
    const existing = await ctx.db.query(
      "SELECT id, role FROM memberships WHERE user_id = $1",
      [userId]
    );

    if (existing.rows.length > 0) {
      await ctx.db.query(
        `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, "auth.login", "user", userId, JSON.stringify({ event, provider })]
      );
      return new Response(JSON.stringify({ ok: true, action: "login_logged" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Allowlist check (email then domain).
    const allow = await ctx.db.query(
      `SELECT default_role FROM app_allowlist
        WHERE active = true
          AND ((entry_type = 'email' AND value = $1) OR (entry_type = 'domain' AND value = $2))
        ORDER BY entry_type = 'email' DESC
        LIMIT 1`,
      [email, domain]
    );

    if (allow.rows.length > 0) {
      const role = allow.rows[0].default_role || "member";
      await ctx.db.query(
        `INSERT INTO memberships (user_id, role, invited_email, added_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, role, email]
      );
      await ctx.db.query(
        `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, "auth.member_joined", "user", userId, JSON.stringify({ event, provider, role, via: "allowlist" })]
      );
      return new Response(JSON.stringify({ ok: true, action: "member_created", role }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // First-user bootstrap window: memberships empty -> caller becomes owner.
    const count = await ctx.db.query("SELECT count(*)::int AS n FROM memberships");
    if (count.rows[0].n === 0) {
      await ctx.db.query(
        `INSERT INTO app_allowlist (entry_type, value, active, default_role, note, created_by)
         VALUES ('email', $1, true, 'owner', 'first-user bootstrap', $2)
         ON CONFLICT (entry_type, value) DO NOTHING`,
        [email, userId]
      );
      await ctx.db.query(
        `INSERT INTO memberships (user_id, role, invited_email, added_at)
         VALUES ($1, 'owner', $2, now())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, email]
      );
      await ctx.db.query(
        `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, "auth.bootstrap", "user", userId, JSON.stringify({ event, provider, role: "owner", via: "first_user" })]
      );
      return new Response(JSON.stringify({ ok: true, action: "bootstrap_owner" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Not invited, not first user -> audit log only. Frontend will show no-access.
    await ctx.db.query(
      `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, "auth.denied_no_invite", "user", userId, JSON.stringify({ event, provider, email })]
    );
    return new Response(JSON.stringify({ ok: true, action: "denied_no_invite" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("auth-bootstrap-hook error:", err?.message, err?.stack);
    // Fire-and-forget contract: never block auth. Always return 2xx.
    return new Response(JSON.stringify({ ok: false, error: err?.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

