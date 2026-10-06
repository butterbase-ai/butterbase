async function substrateReject(env, actionId, reason) {
  const url = `${env.BUTTERBASE_API_URL}/v1/me/substrate/actions/${actionId}/reject`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.BUTTERBASE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ reason: reason || 'expired' }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`substrate reject ${r.status}: ${txt.slice(0,200)}`);
  }
}

export default async function handler(_req, ctx) {
  const r = await ctx.db.query(
    `UPDATE agent_proposals
        SET status = 'expired', resolved_at = now(), updated_at = now()
      WHERE status = 'pending' AND expires_at < now()
      RETURNING id, substrate_action_id`
  );
  const expired = r.rows.length;
  const withSubstrateId = r.rows.filter((row) => row.substrate_action_id);

  let substrateRejected = 0;
  let substrateFailed = 0;
  for (const row of withSubstrateId) {
    try {
      await substrateReject(ctx.env, row.substrate_action_id, 'expired');
      substrateRejected++;
    } catch (err) {
      substrateFailed++;
      console.warn('expire-agent-proposals: substrate.reject failed', {
        proposal_id: row.id,
        substrate_action_id: row.substrate_action_id,
        error: err?.message || String(err),
      });
    }
  }

  if (expired > 0) {
    await ctx.db.query(
      `INSERT INTO activities (actor_user_id, kind, entity_type, entity_id, payload)
       VALUES (NULL, 'proposal.expired_batch', 'agent_proposal', 'cron', $1)`,
      [JSON.stringify({
        count: expired,
        ids: r.rows.map((x) => x.id),
        substrate_rejected: substrateRejected,
        substrate_failed: substrateFailed,
      })],
    );
  }
  console.info(`expire-agent-proposals: ${expired} expired (${substrateRejected} substrate-rejected, ${substrateFailed} failed)`);
  return new Response(
    JSON.stringify({ ok: true, expired, substrate_rejected: substrateRejected, substrate_failed: substrateFailed }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
