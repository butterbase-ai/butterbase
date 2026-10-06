// App-wide allowlist gate. The frontend calls this immediately after login.
// If allowed=false the frontend signs the user out and shows an error.
//
// Bootstrap rules (checked in order):
//   1. If ctx.appOwner.email matches the caller, allow + seed. This is the
//      cloner's escape hatch — works automatically on a fresh clone with
//      no manual config.
//   2. If app_allowlist is empty, the first authenticated user is allowed
//      AND their email is added as the seed entry.
//   3. Otherwise the caller's email or its domain must match an active row.
//
// Robustness: ctx.user.email is sometimes missing on the JWT (e.g. right
// after email/password signup before verification, or older sessions).
// Fall back to the email the frontend passes in the request body so the
// bootstrap path can still seed correctly.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function domainOf(email) {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase();
}

export async function handler(req, ctx) {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });

  let body = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const bodyEmail = typeof body?.email === 'string' ? body.email : null;
  const rawEmail = ctx.user.email || bodyEmail;
  if (!rawEmail) return jsonResponse(400, { error: 'no_email_on_user' });
  const emailLc = String(rawEmail).toLowerCase();
  const dom = domainOf(emailLc);

  const ownerEmail = (ctx.appOwner?.email || '').toLowerCase().trim();

  // Rule 1 — the cloner / app owner is always allowed and auto-seeded.
  if (ownerEmail && ownerEmail === emailLc) {
    try {
      await ctx.db.query(
        `INSERT INTO app_allowlist (entry_type, value, active, note, created_by)
         VALUES ('email', $1, true, 'auto-added: app owner', $2)
         ON CONFLICT (entry_type, value) DO NOTHING`,
        [emailLc, ctx.user.id],
      );
    } catch (_e) { /* non-fatal */ }
    return jsonResponse(200, { allowed: true, isFirstUser: false, matched: 'app_owner' });
  }

  const list = await ctx.db.query(
    `SELECT entry_type, value FROM app_allowlist WHERE active = true`,
  );

  // Rule 2 — bootstrap: empty list seeds the first signup.
  if (list.rows.length === 0) {
    try {
      await ctx.db.query(
        `INSERT INTO app_allowlist (entry_type, value, active, note, created_by)
         VALUES ('email', $1, true, 'auto-added: first signup', $2)
         ON CONFLICT (entry_type, value) DO NOTHING`,
        [emailLc, ctx.user.id],
      );
    } catch (_e) { /* non-fatal */ }
    return jsonResponse(200, { allowed: true, isFirstUser: true, matched: 'bootstrap' });
  }

  // Rule 3 — match an existing entry.
  for (const row of list.rows) {
    const t = String(row.entry_type ?? '').toLowerCase();
    const v = String(row.value ?? '').toLowerCase();
    if (t === 'email' && v === emailLc) {
      return jsonResponse(200, { allowed: true, isFirstUser: false, matched: 'email' });
    }
    if (t === 'domain' && dom && v === dom) {
      return jsonResponse(200, { allowed: true, isFirstUser: false, matched: 'domain' });
    }
  }

  return jsonResponse(200, { allowed: false, isFirstUser: false, reason: 'not_on_allowlist' });
}

