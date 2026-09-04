function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function extractEntityId(result) {
  if (!result) return null;
  return result.entity_id ?? result.id ?? result.entity?.id ?? result.entity?.entity_id ?? null;
}

export async function handler(req, ctx) {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const proposalId = body?.proposal_id;
  if (!proposalId) return jsonResponse(400, { error: 'proposal_id required' });

  const r = await ctx.db.query(
    `SELECT * FROM deal_proposals WHERE id = $1`,
    [proposalId],
  );
  if (r.rows.length === 0) return jsonResponse(404, { error: 'not_found' });
  const p = r.rows[0];
  if (p.status !== 'pending') return jsonResponse(409, { error: 'already_decided', status: p.status });

  const name = body?.override_name?.toString().slice(0, 140) || p.suggested_name;
  const company_id = body?.override_company_id ?? p.company_substrate_id ?? null;
  const primary_person_id = body?.override_person_id ?? p.person_substrate_id ?? null;
  const stage = body?.override_stage ?? p.suggested_stage ?? 'lead';

  // Substrate project entity, kind=deal. Mirrors useCreateDeal on the frontend.
  let verdict;
  try {
    verdict = await ctx.substrate.propose('upsert_entity', {
      type: 'project',
      display_name: name,
      attrs: {
        kind: 'deal',
        name,
        stage,
        company_id,
        primary_person_id,
        amount_cents: p.suggested_amount_cents ?? null,
        owner_user_id: ctx.user.id,
      },
    });
  } catch (e) {
    return jsonResponse(502, { error: 'substrate_propose_failed', detail: String(e?.message ?? e) });
  }
  const dealId = extractEntityId(verdict?.result);
  if (!dealId) return jsonResponse(502, { error: 'substrate_no_entity_id' });

  await ctx.db.query(
    `UPDATE deal_proposals
        SET status = 'accepted', decided_by = $1, decided_at = now(), created_deal_id = $2, updated_at = now()
      WHERE id = $3`,
    [ctx.user.id, dealId, proposalId],
  );

  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'deal.created_from_proposal', 'deal', $3::uuid, $4::jsonb)`,
    [p.workspace_id, ctx.user.id, '00000000-0000-0000-0000-000000000000', JSON.stringify({ proposal_id: proposalId, source_kind: p.source_kind, deal_substrate_id: dealId })],
  ).catch(() => { /* activity ledger uses uuid entity_id; deal is now ent_; logging best-effort */ });

  return jsonResponse(200, { deal_id: dealId, proposal_id: proposalId });
}
