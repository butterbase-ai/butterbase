const PER_TICK_CAP = 50;
const EMAIL_RE = /.+@.+\..+/;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function sendViaGmail(ctx, userId, to, subject, body) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
    },
    body: JSON.stringify({
      toolName: 'GOOGLESUPER_SEND_EMAIL',
      params: { to, subject, body },
      userId,
    }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) {
    return { ok: false, error: `composio ${res.status}: ${text.slice(0, 200)}` };
  }
  if (!parsed?.successful) {
    return { ok: false, error: parsed?.error ?? 'composio_returned_failure' };
  }
  const messageId = parsed?.data?.id ?? parsed?.data?.messageId ?? parsed?.data?.response_data?.id ?? null;
  return { ok: true, messageId };
}

// Substrate is the source of truth for person emails. The `email` column on
// campaign_sends is a stale snapshot that we use only as a fallback.
async function liveEmailFromSubstrate(ctx, entityId, entityType) {
  if (!ctx.substrate || entityType !== 'people' || !entityId) return null;
  try {
    const ent = await ctx.substrate.getEntity(entityId);
    const e = ent?.attrs?.email;
    if (typeof e === 'string' && EMAIL_RE.test(e)) return e;
  } catch { /* fall back to snapshot */ }
  return null;
}

export async function handler(_req, ctx) {
  const startedAt = Date.now();
  const activeRes = await ctx.db.query(
    `SELECT id, workspace_id, from_user_id, daily_limit, throttle_seconds, sent_count, total_count
       FROM campaigns
      WHERE status = 'active'`,
  );
  if (activeRes.rows.length === 0) return json(200, { active: 0, sent: 0, failed: 0 });

  let totalSent = 0;
  let totalFailed = 0;
  let totalSkippedNoEmail = 0;
  let budget = PER_TICK_CAP;

  for (const campaign of activeRes.rows) {
    if (budget <= 0) break;

    const usedRes = await ctx.db.query(
      `SELECT COUNT(*)::int AS n FROM campaign_sends
        WHERE campaign_id = $1 AND status = 'sent' AND sent_at > now() - interval '24 hours'`,
      [campaign.id],
    );
    const used = usedRes.rows[0]?.n ?? 0;
    let allowance = Math.max(0, Math.min(campaign.daily_limit, budget) - used);
    if (allowance <= 0) continue;

    const dueRes = await ctx.db.query(
      `SELECT id, email, resolved_subject, resolved_body, entity_type, entity_id
         FROM campaign_sends
        WHERE campaign_id = $1
          AND status = 'queued'
          AND scheduled_for <= now()
        ORDER BY scheduled_for ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [campaign.id, allowance],
    );

    for (const sendRow of dueRes.rows) {
      const claim = await ctx.db.query(
        `UPDATE campaign_sends
            SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
          WHERE id = $1 AND status = 'queued'
          RETURNING id`,
        [sendRow.id],
      );
      if (claim.rows.length === 0) continue;

      // Pull the live email from substrate; fall back to the queued snapshot.
      const live = await liveEmailFromSubstrate(ctx, sendRow.entity_id, sendRow.entity_type);
      const recipient = live ?? (EMAIL_RE.test(sendRow.email ?? '') ? sendRow.email : null);

      if (!recipient) {
        totalSkippedNoEmail++;
        await ctx.db.query(
          `UPDATE campaign_sends
              SET status = 'failed',
                  error = 'no_email_at_send_time (substrate + snapshot both empty)',
                  updated_at = now()
            WHERE id = $1`,
          [sendRow.id],
        );
        await ctx.db.query(
          `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = now() WHERE id = $1`,
          [campaign.id],
        );
        continue;
      }

      // If we used a live address that differs from the stored snapshot, sync
      // the snapshot so future debugging matches reality.
      if (live && live !== sendRow.email) {
        await ctx.db.query(
          `UPDATE campaign_sends SET email = $2 WHERE id = $1`,
          [sendRow.id, live],
        );
      }

      const result = await sendViaGmail(
        ctx,
        campaign.from_user_id,
        recipient,
        sendRow.resolved_subject ?? '',
        sendRow.resolved_body ?? '',
      );

      if (result.ok) {
        totalSent++;
        budget--;
        await ctx.db.query(
          `UPDATE campaign_sends SET status = 'sent', sent_at = now(), gmail_message_id = $2, updated_at = now() WHERE id = $1`,
          [sendRow.id, result.messageId],
        );
        await ctx.db.query(
          `UPDATE campaigns SET sent_count = sent_count + 1, last_sent_at = now(), updated_at = now() WHERE id = $1`,
          [campaign.id],
        );
        await ctx.db.query(
          `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
           VALUES ($1, $2, 'email.campaign_sent', $3, $4, $5::jsonb)`,
          [campaign.workspace_id, campaign.from_user_id, sendRow.entity_type, sendRow.entity_id,
           JSON.stringify({ campaign_id: campaign.id, to: recipient, subject: sendRow.resolved_subject, gmail_message_id: result.messageId })],
        ).catch(() => {});
      } else {
        totalFailed++;
        budget--;
        await ctx.db.query(
          `UPDATE campaign_sends SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
          [sendRow.id, String(result.error).slice(0, 1000)],
        );
        await ctx.db.query(
          `UPDATE campaigns SET failed_count = failed_count + 1, updated_at = now() WHERE id = $1`,
          [campaign.id],
        );
      }

      if (budget <= 0) break;
    }

    const remaining = await ctx.db.query(
      `SELECT COUNT(*)::int AS n FROM campaign_sends WHERE campaign_id = $1 AND status IN ('queued','sending')`,
      [campaign.id],
    );
    if ((remaining.rows[0]?.n ?? 0) === 0) {
      await ctx.db.query(
        `UPDATE campaigns SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND status = 'active'`,
        [campaign.id],
      );
    }
  }

  return json(200, {
    active: activeRes.rows.length,
    sent: totalSent,
    failed: totalFailed,
    skipped_no_email: totalSkippedNoEmail,
    duration_ms: Date.now() - startedAt,
  });
}

