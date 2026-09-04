function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function extractArtifactId(result) {
  if (!result) return null;
  return result.source_artifact_id ?? result.artifact_id ?? result.id ?? result.artifact?.id ?? result.source_artifact?.id ?? null;
}

function extractRecordId(verdict) {
  const r = verdict?.result ?? verdict ?? null;
  if (!r) return null;
  return r.decision_id ?? r.commitment_id ?? r.learning_id ?? r.id ?? r.entity_id ?? null;
}

function isUnknownCapability(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  return msg.includes('unknown_capability') || msg.includes('unknown capability');
}

function safeJsonExtract(text) {
  if (!text) return null;
  const fenced = text.match(/```json([\s\S]*?)```/i) ?? text.match(/```([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

const DECISION_KINDS = new Set([
  'operational', 'strategic', 'mission', 'vision', 'principle', 'policy_decision',
]);

function buildEmailToEntityId(meetingAttrs) {
  const map = new Map();
  const attendees = Array.isArray(meetingAttrs?.attendees) ? meetingAttrs.attendees : [];
  for (const a of attendees) {
    const email = typeof a?.email === 'string' ? a.email.toLowerCase().trim() : '';
    if (!email) continue;
    if (typeof a?.entity_id === 'string') map.set(email, a.entity_id);
  }
  return map;
}

async function inlineExtract(ctx, sourceArtifactId, emailToEntityId, transcript, title) {
  const prompt = `You extract structured outcomes from a meeting transcript. Be terse.

Return STRICT JSON in this exact shape (no prose, no fences):
{
  "decisions":   [{"title": "<short>", "kind": "operational|strategic|mission|vision|principle|policy_decision"}],
  "commitments": [{"description": "<short>", "due_at": "<ISO date or null>", "owner_email": "<email or null>"}],
  "learnings":   [{"title": "<short>", "description": "<1-2 sentence insight>"}]
}

Decision "kind" guide: operational = day-to-day work choice; strategic = direction-setting; mission/vision = identity-level; principle = team value; policy_decision = formal rule. Default to "operational" if unsure.

Any array may be empty. Output 0-8 items per array. Skip filler.

MEETING TITLE: ${title}

TRANSCRIPT:
${transcript.slice(0, 60000)}`;

  const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', messages: [{ role: 'user', content: prompt }], max_tokens: 1500, temperature: 0.2 }),
  });
  if (!aiRes.ok) return { ok: false, error: `ai_call_failed:${aiRes.status}`, counts: null };
  const aiJson = await aiRes.json();
  const content = aiJson?.choices?.[0]?.message?.content ?? '';
  const parsed = safeJsonExtract(content);
  if (!parsed) return { ok: false, error: 'ai_unparseable', counts: null };

  const decisions = Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 8) : [];
  const commitments = Array.isArray(parsed.commitments) ? parsed.commitments.slice(0, 8) : [];
  const learnings = Array.isArray(parsed.learnings) ? parsed.learnings.slice(0, 8) : [];

  const errors = [];
  const summaries = { decisions: [], commitments: [], learnings: [] };
  const proposeOne = async (capability, payload) => {
    try { return await ctx.substrate.propose(capability, payload); }
    catch (e) { errors.push(`${capability}:${String(e?.message ?? e).slice(0, 120)}`); return null; }
  };

  for (const d of decisions) {
    const t = typeof d?.title === 'string' ? d.title.trim() : '';
    if (!t) continue;
    const kind = typeof d?.kind === 'string' && DECISION_KINDS.has(d.kind) ? d.kind : 'operational';
    const v = await proposeOne('record_decision', {
      title: t,
      kind,
      source_artifact_id: sourceArtifactId,
    });
    const id = extractRecordId(v);
    if (id) summaries.decisions.push({ id, title: t, kind, source_artifact_id: sourceArtifactId });
  }
  for (const c of commitments) {
    const description = typeof c?.description === 'string'
      ? c.description.trim()
      : typeof c?.title === 'string' ? c.title.trim() : '';
    if (!description) continue;
    const ownerEmail = typeof c?.owner_email === 'string' ? c.owner_email.toLowerCase().trim() : '';
    const ownerEntityId = ownerEmail ? emailToEntityId.get(ownerEmail) ?? null : null;
    const title = description.slice(0, 140);
    const dueAt = c?.due_at ?? null;
    const v = await proposeOne('record_commitment', {
      title,
      description,
      status: 'proposed',
      ...(dueAt ? { due_at: dueAt } : {}),
      source_artifact_id: sourceArtifactId,
      ...(ownerEntityId ? { owner_entity_id: ownerEntityId } : {}),
    });
    const id = extractRecordId(v);
    if (id) summaries.commitments.push({
      id, title, description, status: 'proposed',
      ...(dueAt ? { due_at: dueAt } : {}),
      ...(ownerEmail ? { owner_email: ownerEmail } : {}),
      ...(ownerEntityId ? { owner_entity_id: ownerEntityId } : {}),
      source_artifact_id: sourceArtifactId,
    });
  }
  for (const l of learnings) {
    const description = typeof l?.description === 'string'
      ? l.description.trim()
      : typeof l?.content === 'string' ? l.content.trim() : '';
    if (!description) continue;
    const t = typeof l?.title === 'string' && l.title.trim()
      ? l.title.trim()
      : description.split(/[.!?]/)[0].slice(0, 80);
    const v = await proposeOne('record_learning', {
      title: t,
      description,
      source_artifact_id: sourceArtifactId,
    });
    const id = extractRecordId(v);
    if (id) summaries.learnings.push({ id, title: t, description, source_artifact_id: sourceArtifactId });
  }

  return {
    ok: true,
    error: null,
    summaries,
    counts: { decisions: decisions.length, commitments: commitments.length, learnings: learnings.length, errors: errors.length },
  };
}

export async function handler(req, ctx) {
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { return jsonResponse(400, { error: 'invalid_json' }); }

  const meetingId = typeof body?.meeting_id === 'string' ? body.meeting_id : '';
  const transcript = typeof body?.transcript_text === 'string' ? body.transcript_text : '';
  const externalSystem = typeof body?.external_system === 'string' ? body.external_system : 'manual-paste';
  if (!meetingId) return jsonResponse(400, { error: 'meeting_id required' });
  if (!transcript || transcript.trim().length < 50) return jsonResponse(400, { error: 'transcript_text required (min 50 chars)' });

  const meeting = await ctx.substrate.getEntity(meetingId).catch(() => null);
  if (!meeting) return jsonResponse(404, { error: 'not_found' });

  const meetingAttrs = meeting.attrs ?? {};
  const attendeeEntityIds = Array.isArray(meetingAttrs.attendee_entity_ids) ? meetingAttrs.attendee_entity_ids : [];

  let artifactVerdict;
  try {
    artifactVerdict = await ctx.substrate.propose('upsert_source_artifact', {
      kind: 'meeting_notes', external_system: externalSystem, external_id: meetingId,
      title: meeting.display_name ?? meetingAttrs.title ?? 'Meeting transcript',
      summary: '', content: transcript,
      storage_object_id: body.recording_storage_object_id ?? undefined,
      links: { entity_ids: attendeeEntityIds },
      attrs: {
        workspace_id: meetingAttrs.workspace_id, meeting_entity_id: meetingId,
        speaker_turns: body.speaker_turns ?? undefined, duration_seconds: body.duration_seconds ?? undefined,
      },
    });
  } catch (e) {
    return jsonResponse(502, { error: 'source_artifact_propose_failed', detail: String(e?.message ?? e) });
  }

  const sourceArtifactId = extractArtifactId(artifactVerdict?.result);
  if (!sourceArtifactId) return jsonResponse(502, { error: 'source_artifact_id_missing', verdict: artifactVerdict });

  let extraction_triggered = false;
  let extraction_mode = 'none';
  let extraction_detail = null;
  let summaries = null;
  try {
    await ctx.substrate.propose('extract_from_source_artifact', { artifact_id: sourceArtifactId });
    extraction_triggered = true;
    extraction_mode = 'capability';
  } catch (e) {
    if (isUnknownCapability(e)) {
      const emailToEntityId = buildEmailToEntityId(meetingAttrs);
      const result = await inlineExtract(ctx, sourceArtifactId, emailToEntityId, transcript, meeting.display_name ?? meetingAttrs.title ?? 'Meeting').catch((err) => ({ ok: false, error: String(err?.message ?? err), counts: null }));
      extraction_triggered = !!result.ok;
      extraction_mode = 'inline';
      extraction_detail = result;
      if (result?.summaries) summaries = result.summaries;
    } else {
      extraction_detail = { error: String(e?.message ?? e) };
    }
  }

  // Denorm onto meeting entity so get-meeting-notes can render without
  // hitting the action ledger (which currently 401s with the auto-injected
  // service key — see Fix 13A platform note).
  const mergedAttrs = { ...(meeting.attrs ?? {}) };
  mergedAttrs.notetaker_artifact_id = sourceArtifactId;
  mergedAttrs.notetaker_status = 'done';
  mergedAttrs.notetaker_completed_at = new Date().toISOString();
  mergedAttrs.notetaker_transcript_text = transcript;
  mergedAttrs.notetaker_external_system = externalSystem;
  if (typeof body?.duration_seconds === 'number') {
    mergedAttrs.notetaker_duration_seconds = body.duration_seconds;
  }
  if (summaries) {
    mergedAttrs.notetaker_decisions = summaries.decisions;
    mergedAttrs.notetaker_commitments = summaries.commitments;
    mergedAttrs.notetaker_learnings = summaries.learnings;
  }
  try {
    await ctx.substrate.propose('update_entity', { id: meetingId, attrs: mergedAttrs, display_name: meeting.display_name });
  } catch (e) {
    console.warn('update_entity failed', String(e?.message ?? e));
  }

  return jsonResponse(200, { ok: true, meeting_id: meetingId, source_artifact_id: sourceArtifactId, extraction_triggered, extraction_mode, extraction_detail });
}

