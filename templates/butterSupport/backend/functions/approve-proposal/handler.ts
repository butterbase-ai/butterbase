function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
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

async function substrateDecide(env, actionId, decision, reason) {
  const url = `${env.BUTTERBASE_API_URL}/v1/me/substrate/actions/${actionId}/${decision}`;
  const body = decision === 'reject' ? JSON.stringify({ reason: reason || 'rejected' }) : '{}';
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.BUTTERBASE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body,
  });
  const txt = await r.text();
  let parsed = null; try { parsed = JSON.parse(txt); } catch {}
  if (!r.ok) {
    const errMsg = typeof parsed?.error === 'string'
      ? parsed.error
      : (parsed?.error?.message || parsed?.message || txt).toString().slice(0, 200);
    const err = new Error(`substrate ${decision} ${r.status}: ${errMsg}`);
    err.status = r.status;
    throw err;
  }
  return parsed ?? { ok: true };
}

export default async function handler(req, ctx) {
  if (!ctx.user) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const { proposal_id } = body || {};
  if (!proposal_id) return json({ error: "missing_proposal_id" }, 400);

  if (!(await ctx.idempotency.claim(proposal_id, { scope: "approve_proposal", ttlSeconds: 3600 }))) {
    return json({ ok: true, duplicate: true });
  }

  const prop = await ctx.db.query(
    `SELECT id, ticket_id, capability, substrate_action_id, status
       FROM agent_proposals WHERE id = $1`,
    [proposal_id]
  );
  if (prop.rows.length === 0) return json({ error: "not_found" }, 404);
  const p = prop.rows[0];
  if (p.status !== "pending") return json({ error: "wrong_status", status: p.status }, 409);

  let substrateResult = null;
  try {
    if (p.substrate_action_id) {
      substrateResult = await substrateDecide(ctx.env, p.substrate_action_id, 'approve');
    } else {
      console.warn("approve-proposal: no substrate_action_id stored", proposal_id);
    }
  } catch (err) {
    console.error("approve-proposal: substrate approve failed", err?.message);
    return json({ error: "substrate_approve_failed", message: err?.message }, 502);
  }

  await ctx.db.query(
    `UPDATE agent_proposals
        SET status = 'approved', resolved_by = $1, resolved_at = now(), updated_at = now()
      WHERE id = $2`,
    [ctx.user.id, proposal_id]
  );

  await ctx.db.query(
    `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, 'proposal.approved', 'agent_proposal', $2::text, $3)`,
    [ctx.user.id, proposal_id, JSON.stringify({ ticket_id: p.ticket_id, capability: p.capability, substrate_action_id: p.substrate_action_id })]
  );

  ctx.waitUntil(fireSyncArtifact(ctx, p.ticket_id));

  return json({ ok: true, proposal_id, substrate_result: substrateResult });
}
