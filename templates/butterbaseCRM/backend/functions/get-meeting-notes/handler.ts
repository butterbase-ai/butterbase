function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// The UI's TakeawaySection renders {item.text} — title alone, or
// title-and-description for learnings. Derive that here so the renderer
// doesn't have to know the per-capability field shape.
function decisionText(d)   { return d?.title ?? null; }
function commitmentText(c) { return c?.description ?? c?.title ?? null; }
function learningText(l) {
  const t = l?.title ?? '';
  const d = l?.description ?? '';
  if (t && d) return `${t} — ${d}`;
  return t || d || null;
}

function shapeDecision(d) {
  return { ...d, text: decisionText(d) };
}
function shapeCommitment(c) {
  return { ...c, text: commitmentText(c) };
}
function shapeLearning(l) {
  return { ...l, text: learningText(l) };
}

// Primary read: denorm fields written by ingest-meeting-transcript onto the
// meeting entity. Fallback: live ledger via the platform HTTP API (requires a
// bb_sk_* with substrate_access in BUTTERBASE_API_KEY — currently 401s with
// the auto-injected service key; kept as a try/catch so the denorm path
// continues to work even when the ledger is unreachable).
async function fetchLedgerActions(ctx, capability) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/me/substrate/actions?capability=${encodeURIComponent(capability)}&limit=200`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
  });
  if (!res.ok) {
    console.warn(`ledger /actions ${capability} ${res.status}`);
    return null;
  }
  const j = await res.json().catch(() => null);
  if (!j) return null;
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.actions)) return j.actions;
  if (Array.isArray(j.items)) return j.items;
  return [];
}

async function fetchLedgerArtifact(ctx, artifactId) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/me/substrate/source-artifacts/${encodeURIComponent(artifactId)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
  });
  if (!res.ok) {
    console.warn(`ledger /source-artifacts ${res.status}`);
    return null;
  }
  const j = await res.json().catch(() => null);
  return j?.source_artifact ?? j?.artifact ?? j ?? null;
}

function actionToItem(action, capability) {
  const p = action?.payload ?? {};
  const id = action?.id ?? action?.action_id ?? p.decision_id ?? p.commitment_id ?? p.learning_id ?? null;
  const source_artifact_id = p.source_artifact_id ?? action?.source_artifact_id ?? null;
  if (capability === 'record_decision') {
    return { id, title: p.title ?? null, kind: p.kind ?? null, source_artifact_id };
  }
  if (capability === 'record_commitment') {
    return {
      id,
      title: p.title ?? null,
      description: p.description ?? null,
      status: p.status ?? null,
      due_at: p.due_at ?? null,
      owner_entity_id: p.owner_entity_id ?? null,
      source_artifact_id,
    };
  }
  return {
    id,
    title: p.title ?? null,
    description: p.description ?? null,
    source_artifact_id,
  };
}

function actionMatchesArtifact(action, artifactId) {
  if (!action || !artifactId) return false;
  const sai = action.payload?.source_artifact_id ?? action.source_artifact_id ?? null;
  return sai === artifactId;
}

export async function handler(req, ctx) {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const meetingId = typeof body?.meeting_id === 'string' ? body.meeting_id : '';
  if (!meetingId) return jsonResponse(400, { error: 'meeting_id required' });

  const meeting = await ctx.substrate.getEntity(meetingId).catch(() => null);
  if (!meeting) return jsonResponse(404, { error: 'not_found' });

  const attrs = meeting.attrs ?? {};
  const artifactId = attrs.notetaker_artifact_id ?? null;
  const status = attrs.notetaker_status ?? 'idle';

  let artifact = null;
  if (typeof attrs.notetaker_transcript_text === 'string') {
    artifact = {
      id: artifactId,
      kind: 'meeting_notes',
      external_system: attrs.notetaker_external_system ?? null,
      content: attrs.notetaker_transcript_text,
      attrs: {
        duration_seconds: attrs.notetaker_duration_seconds ?? null,
        meeting_entity_id: meetingId,
      },
    };
  } else if (artifactId) {
    try { artifact = await fetchLedgerArtifact(ctx, artifactId); }
    catch (e) { console.warn('artifact fetch failed', String(e?.message ?? e)); }
  }

  let decisions = Array.isArray(attrs.notetaker_decisions) ? attrs.notetaker_decisions.map(shapeDecision) : null;
  let commitments = Array.isArray(attrs.notetaker_commitments) ? attrs.notetaker_commitments.map(shapeCommitment) : null;
  let learnings = Array.isArray(attrs.notetaker_learnings) ? attrs.notetaker_learnings.map(shapeLearning) : null;

  if ((decisions === null || commitments === null || learnings === null) && artifactId) {
    try {
      const [decRaw, comRaw, lrnRaw] = await Promise.all([
        fetchLedgerActions(ctx, 'record_decision'),
        fetchLedgerActions(ctx, 'record_commitment'),
        fetchLedgerActions(ctx, 'record_learning'),
      ]);
      if (decisions === null && Array.isArray(decRaw)) {
        decisions = decRaw.filter((a) => actionMatchesArtifact(a, artifactId))
          .map((a) => shapeDecision(actionToItem(a, 'record_decision')));
      }
      if (commitments === null && Array.isArray(comRaw)) {
        commitments = comRaw.filter((a) => actionMatchesArtifact(a, artifactId))
          .map((a) => shapeCommitment(actionToItem(a, 'record_commitment')));
      }
      if (learnings === null && Array.isArray(lrnRaw)) {
        learnings = lrnRaw.filter((a) => actionMatchesArtifact(a, artifactId))
          .map((a) => shapeLearning(actionToItem(a, 'record_learning')));
      }
    } catch (e) {
      console.warn('ledger fallback failed', String(e?.message ?? e));
    }
  }

  return jsonResponse(200, {
    meeting_id: meetingId,
    artifact,
    decisions: decisions ?? [],
    commitments: commitments ?? [],
    learnings: learnings ?? [],
    status,
  });
}

