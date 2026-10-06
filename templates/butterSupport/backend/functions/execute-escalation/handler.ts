function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

async function verifyOutboxHmac(rawBody, sigHeader, signingSecret) {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const provided = sigHeader.slice("sha256=".length);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== provided.length) return false;
  let r = 0;
  for (let i = 0; i < expected.length; i++) r |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return r === 0;
}

const COMPOSIO_TIMEOUT_MS = 8000;
const COMPOSIO_MAX_ATTEMPTS = 3;
const COMPOSIO_BACKOFF_MS = [0, 1000, 2000];

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function runComposioWithRetry(label, fn) {
  let lastErr = null;
  for (let attempt = 1; attempt <= COMPOSIO_MAX_ATTEMPTS; attempt++) {
    const backoff = COMPOSIO_BACKOFF_MS[attempt - 1] || 0;
    if (backoff > 0) {
      await new Promise(r => setTimeout(r, backoff));
    }
    const t0 = Date.now();
    try {
      const result = await withTimeout(fn(), COMPOSIO_TIMEOUT_MS, `${label} attempt ${attempt}`);
      console.log(`composio ${label} attempt ${attempt} ok in ${Date.now() - t0}ms`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`composio ${label} attempt ${attempt} failed in ${Date.now() - t0}ms:`, err?.message || err);
    }
  }
  throw lastErr || new Error(`${label} failed after ${COMPOSIO_MAX_ATTEMPTS} attempts`);
}

async function fireSyncArtifact(ctx, ticketId) {
  try {
    const r = await ctx.invoke('sync-ticket-artifact', { ticket_id: ticketId });
    if (!r.ok) {
      console.warn('sync-ticket-artifact non-2xx', r.status, (await r.text().catch(() => '')).slice(0, 200));
    }
  } catch (err) {
    console.warn('sync-ticket-artifact invoke failed', err?.message);
  }
}

const CONSOLE_BASE = "https://butter-support.butterbase.dev";

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatRelative(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function urgencyChrome(urgency) {
  switch ((urgency || "").toLowerCase()) {
    case "urgent": return { label: "URGENT", icon: "🚨", color: "#b91c1c", bg: "#fef2f2" };
    case "high":   return { label: "HIGH",   icon: "⚠️", color: "#b45309", bg: "#fffbeb" };
    case "low":    return { label: "LOW",    icon: "🔵", color: "#1d4ed8", bg: "#eff6ff" };
    default:       return { label: "NORMAL", icon: "•",  color: "#374151", bg: "#f3f4f6" };
  }
}

function roleLabel(role) {
  switch (role) {
    case "customer":   return "Customer";
    case "agent_draft": return "Agent draft";
    case "founder":    return "You";
    case "system":     return "System";
    case "assistant":  return "Assistant";
    default:           return role || "—";
  }
}

function roleColor(role) {
  switch (role) {
    case "customer":   return "#1f2937";
    case "agent_draft": return "#6b7280";
    case "founder":    return "#0f766e";
    case "system":     return "#9ca3af";
    default:           return "#374151";
  }
}

function buildPlainBody({ ticket, payload, urgency, messages, diagnosis, ticketUrl }) {
  const chrome = urgencyChrome(urgency);
  const lines = [
    `${chrome.icon} Support escalation — ${chrome.label}`,
    "",
    `Reason: ${payload?.reason || "agent needs human"}`,
    `Issue type: ${ticket.issue_type || "—"}`,
    "",
    "Customer",
    `  Email:    ${ticket.customer_email || "—"}`,
    `  Name:     ${ticket.customer_name || "—"}`,
    ticket.customer_external_id ? `  External: ${ticket.customer_external_id}` : null,
    "",
    "Ticket",
    `  Subject: ${ticket.subject || "(none)"}`,
    `  Status:  ${ticket.status}`,
    `  Opened:  ${formatRelative(ticket.opened_at)}`,
    `  Link:    ${ticketUrl}`,
  ].filter(Boolean);

  if (messages.length) {
    lines.push("", "Recent conversation");
    for (const m of messages) {
      const body = (m.body || "").replace(/\s+/g, " ").slice(0, 500);
      lines.push(`  [${roleLabel(m.role)}] ${body}`);
    }
  }

  if (diagnosis) {
    lines.push("", `Diagnosis (${diagnosis.confidence}): ${diagnosis.summary}`);
  }
  if (payload?.context_snapshot?.actions_tried) {
    const tried = Array.isArray(payload.context_snapshot.actions_tried)
      ? payload.context_snapshot.actions_tried.join(", ")
      : payload.context_snapshot.actions_tried;
    lines.push(`Tried: ${tried}`);
  }

  return lines.join("\n");
}

function buildHtmlBody({ ticket, payload, urgency, messages, diagnosis, ticketUrl }) {
  const chrome = urgencyChrome(urgency);
  const reason = escapeHtml(payload?.reason || "agent needs human");
  const subject = escapeHtml(ticket.subject || "(no subject)");
  const email = escapeHtml(ticket.customer_email || "—");
  const name = escapeHtml(ticket.customer_name || "");
  const issueType = escapeHtml(ticket.issue_type || "—");
  const status = escapeHtml(ticket.status || "—");
  const openedRel = escapeHtml(formatRelative(ticket.opened_at));

  const msgsHtml = messages.length
    ? messages.map(m => {
        const body = escapeHtml((m.body || "").slice(0, 1500));
        return `
          <div style="margin:0 0 12px 0;padding:10px 14px;background:#fafaf9;border-left:3px solid ${roleColor(m.role)};border-radius:4px;">
            <div style="font:600 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-transform:uppercase;letter-spacing:0.05em;color:${roleColor(m.role)};margin-bottom:4px;">${escapeHtml(roleLabel(m.role))} <span style="color:#9ca3af;font-weight:400;text-transform:none;letter-spacing:0;">· ${escapeHtml(formatRelative(m.created_at))}</span></div>
            <div style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2937;white-space:pre-wrap;">${body}</div>
          </div>`;
      }).join("")
    : `<div style="color:#9ca3af;font-style:italic;font-size:13px;">No messages on this ticket yet.</div>`;

  const diagnosisHtml = diagnosis
    ? `
      <h3 style="font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;margin:28px 0 10px 0;">Agent diagnosis (${escapeHtml(diagnosis.confidence || "med")})</h3>
      <div style="font:400 14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#374151;padding:12px 14px;background:#fafaf9;border-radius:6px;">${escapeHtml(diagnosis.summary || "")}</div>`
    : "";

  const actionsTried = payload?.context_snapshot?.actions_tried;
  const triedHtml = actionsTried
    ? `<div style="margin-top:8px;font-size:13px;color:#6b7280;"><strong>Tried:</strong> ${escapeHtml(Array.isArray(actionsTried) ? actionsTried.join(", ") : actionsTried)}</div>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="padding:18px 24px;background:${chrome.bg};border-bottom:1px solid #e5e7eb;">
      <div style="display:inline-block;padding:4px 10px;background:${chrome.color};color:#ffffff;border-radius:4px;font:700 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:0.05em;">${chrome.icon} ${chrome.label}</div>
      <div style="margin-top:8px;font:600 18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;">Support escalation</div>
      <div style="margin-top:4px;font:400 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#4b5563;">${reason}</div>
    </div>

    <div style="padding:20px 24px;">
      <table style="width:100%;border-collapse:collapse;font:400 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#374151;">
        <tr><td style="padding:4px 0;width:110px;color:#6b7280;">Customer</td><td style="padding:4px 0;"><strong>${email}</strong>${name ? ` <span style="color:#9ca3af;">· ${name}</span>` : ""}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Subject</td><td style="padding:4px 0;">${subject}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Issue type</td><td style="padding:4px 0;"><code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px;">${issueType}</code></td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Status</td><td style="padding:4px 0;">${status}</td></tr>
        <tr><td style="padding:4px 0;color:#6b7280;">Opened</td><td style="padding:4px 0;">${openedRel}</td></tr>
      </table>

      <h3 style="font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;margin:24px 0 10px 0;">Recent conversation</h3>
      ${msgsHtml}

      ${diagnosisHtml}
      ${triedHtml}

      <div style="margin-top:28px;text-align:center;">
        <a href="${ticketUrl}" style="display:inline-block;padding:11px 22px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font:600 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">Open ticket in console →</a>
      </div>
      <div style="margin-top:10px;text-align:center;font-size:11px;color:#9ca3af;">${escapeHtml(ticketUrl)}</div>
    </div>

    <div style="padding:12px 24px;background:#fafaf9;border-top:1px solid #e5e7eb;font:400 11px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#9ca3af;">
      Ticket <code style="background:transparent;color:#6b7280;">${escapeHtml(ticket.id)}</code> · Escalated by Butter Support
    </div>
  </div>
</body></html>`;
}

export default async function handler(req, ctx) {
  const rawBody = await req.text();

  const sig = req.headers.get("X-Butterbase-Signature");
  if (ctx.env.SUBSTRATE_OUTBOX_SECRET) {
    const ok = await verifyOutboxHmac(rawBody, sig, ctx.env.SUBSTRATE_OUTBOX_SECRET);
    if (!ok) return json({ error: "bad_signature" }, 401);
  } else {
    console.warn("execute-escalation: SUBSTRATE_OUTBOX_SECRET not set — skipping HMAC verify (DEV ONLY)");
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: "invalid_json" }, 400); }
  const { action_id, payload, ticket_ref } = body || {};
  const ticket_id = payload?.ticket_id || ticket_ref?.ticket_id;
  if (!action_id || !ticket_id) return json({ error: "missing_fields" }, 400);

  if (!(await ctx.idempotency.claim(action_id, { scope: "substrate_outbox", ttlSeconds: 7 * 86400 }))) {
    return json({ duplicate: true }, 200);
  }

  const t = await ctx.db.query(
    `SELECT id, customer_email, customer_name, customer_external_id, subject, status,
            issue_type, topic_tag, opened_at, identity_verified, customer_substrate_id
     FROM support_tickets WHERE id = $1`,
    [ticket_id]
  );
  if (t.rows.length === 0) return json({ error: "ticket_not_found", ticket_id }, 404);
  const ticket = t.rows[0];

  let targets = [];
  if (payload?.target_config_id) {
    const r = await ctx.db.query("SELECT id, channel, config FROM escalation_targets WHERE id = $1 AND active = true", [payload.target_config_id]);
    targets = r.rows;
  } else {
    const r = await ctx.db.query("SELECT id, channel, config FROM escalation_targets WHERE active = true ORDER BY created_at ASC");
    targets = r.rows;
  }

  let messages = [];
  try {
    const r = await ctx.db.query(
      `SELECT role, body, created_at FROM support_messages
       WHERE ticket_id = $1 AND role IN ('customer','agent_draft','founder','system')
       ORDER BY created_at DESC LIMIT 6`,
      [ticket_id]
    );
    messages = (r.rows || []).reverse();
  } catch (err) {
    console.warn("execute-escalation: messages lookup failed", err?.message);
  }

  let diagnosis = null;
  try {
    const r = await ctx.db.query(
      `SELECT summary, confidence FROM diagnoses
       WHERE ticket_id = $1 AND superseded_at IS NULL
       ORDER BY produced_at DESC LIMIT 1`,
      [ticket_id]
    );
    if (r.rows[0]) diagnosis = { summary: r.rows[0].summary, confidence: r.rows[0].confidence };
  } catch {}

  if (!diagnosis && payload?.context_snapshot?.diagnosis) {
    diagnosis = {
      summary: payload.context_snapshot.diagnosis,
      confidence: payload.context_snapshot.diagnosis_confidence || "med",
    };
  }

  const urgency = payload?.urgency || payload?.context_snapshot?.urgency || "normal";
  const ticketUrl = `${CONSOLE_BASE}/inbox/${ticket.id}`;

  if (targets.length === 0) {
    await ctx.db.query(
      `INSERT INTO escalations (ticket_id, target_id, reason, context_snapshot, substrate_action_id, idempotency_key, status, error)
       VALUES ($1, NULL, $2, $3, $4, $5, 'failed', $6)`,
      [ticket_id, payload?.reason || null, JSON.stringify(payload?.context_snapshot || {}), action_id, action_id, "no_escalation_target_configured"]
    );
    await ctx.db.query(
      `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
       VALUES (NULL, 'unescalated_block', 'support_ticket', $1::text, $2)`,
      [ticket_id, JSON.stringify({ reason: "no_escalation_target_configured", substrate_action_id: action_id })]
    );
    ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));
    return json({ ok: false, reason: "no_target", result_for_ledger: { delivered: false, error: "no_target" } });
  }

  const plainBody = buildPlainBody({ ticket, payload, urgency, messages, diagnosis, ticketUrl });
  const htmlBody = buildHtmlBody({ ticket, payload, urgency, messages, diagnosis, ticketUrl });

  const chrome = urgencyChrome(urgency);
  const customerLabel = ticket.customer_email || ticket.customer_name || "customer";
  const subjectLine = `${chrome.icon} [${chrome.label}] Support escalation · ${ticket.subject || "(no subject)"} · ${customerLabel}`;

  async function deliverToTarget(target) {
    let delivered = false;
    let deliveryError = null;
    try {
      const connectedUserId = target.config?.connected_user_id || target.config?.user_id;
      if (!connectedUserId) throw new Error("target missing connected_user_id in config");

      if (target.channel === "slack") {
        const channel = target.config?.channel_id;
        if (!channel) throw new Error("slack target missing channel_id");
        const text = `:rotating_light: *Support escalation* — ${payload?.reason || "agent needs human"}\n*${ticket.customer_email || "unknown"}* · ${ticket.subject || "(no subject)"}\n${ticketUrl}`;
        await runComposioWithRetry("SLACK_CHAT_POST_MESSAGE", () =>
          ctx.integrations.asUser(connectedUserId).execute("SLACK_CHAT_POST_MESSAGE", { channel, text })
        );
        delivered = true;
      } else if (target.channel === "email") {
        const to = target.config?.to;
        if (!to) throw new Error("email target missing to");
        await runComposioWithRetry("GMAIL_SEND_EMAIL", () =>
          ctx.integrations.asUser(connectedUserId).execute("GMAIL_SEND_EMAIL", {
            to,
            cc: target.config?.cc || undefined,
            subject: subjectLine,
            body: htmlBody,
            is_html: true,
          })
        );
        delivered = true;
      } else {
        throw new Error(`unknown channel: ${target.channel}`);
      }
    } catch (err) {
      deliveryError = err?.message || "unknown_error";
      console.error(`execute-escalation: delivery failed (${target.channel} ${target.id})`, deliveryError);
    }

    if (!delivered && target.channel === "email" && deliveryError && /is_html|html|unsupported|invalid/i.test(deliveryError)) {
      try {
        const connectedUserId = target.config?.connected_user_id || target.config?.user_id;
        const to = target.config?.to;
        await runComposioWithRetry("GMAIL_SEND_EMAIL_plain", () =>
          ctx.integrations.asUser(connectedUserId).execute("GMAIL_SEND_EMAIL", {
            to,
            cc: target.config?.cc || undefined,
            subject: subjectLine,
            body: plainBody,
          })
        );
        delivered = true;
        deliveryError = null;
        console.warn(`execute-escalation: html rejected for ${target.id}, fell back to plain text`);
      } catch (err2) {
        console.error(`execute-escalation: plain-text fallback also failed for ${target.id}`, err2?.message);
      }
    }

    return { target, delivered, error: deliveryError };
  }

  const outcomes = await Promise.all(targets.map(deliverToTarget));

  for (const o of outcomes) {
    await ctx.db.query(
      `INSERT INTO escalations (ticket_id, target_id, reason, context_snapshot, substrate_action_id, idempotency_key, status, error, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        ticket_id, o.target.id, payload?.reason || null,
        JSON.stringify(payload?.context_snapshot || {}),
        action_id, `${action_id}:${o.target.id}`,
        o.delivered ? "sent" : "failed",
        o.error, o.delivered ? new Date().toISOString() : null,
      ]
    );

    await ctx.db.query(
      `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
       VALUES (NULL, $1, 'support_ticket', $2::text, $3)`,
      [o.delivered ? "escalation.sent" : "escalation.failed", ticket_id,
       JSON.stringify({ channel: o.target.channel, target_id: o.target.id, substrate_action_id: action_id, error: o.error })]
    );
  }

  const anyDelivered = outcomes.some(o => o.delivered);
  if (anyDelivered) {
    await ctx.db.query("UPDATE support_tickets SET status = 'escalated', updated_at = now() WHERE id = $1", [ticket_id]);
  }

  ctx.waitUntil(fireSyncArtifact(ctx, ticket_id));

  return json({
    ok: anyDelivered,
    result_for_ledger: {
      delivered: anyDelivered,
      targets: outcomes.map(o => ({ target_id: o.target.id, channel: o.target.channel, delivered: o.delivered, error: o.error })),
    },
  });
}


