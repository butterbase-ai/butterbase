function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacBase64(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

async function getBot(ctx, botId) {
  const res = await fetch(
    `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/ai/meetings/${botId}`,
    { headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` } },
  );
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// Recall delivers transcripts at presigned S3 URLs (*.amazonaws.com/...?AWSAccessKeyId=...&Signature=...).
// S3 rejects requests when an extra Authorization header is layered on top of
// presigned query auth — symptom is an empty body and a downstream
// "empty_transcript" 502. Fetch the URL bare; it carries its own auth.
async function fetchTranscriptText(_ctx, transcriptUrl) {
  const res = await fetch(transcriptUrl);
  if (!res.ok) return null;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json') || ct === '' || ct.includes('octet-stream')) {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return renderTranscript(j);
    } catch {
      return text;
    }
  }
  return res.text();
}

// Recall's diarized-processed1.1.json is a TOP-LEVEL ARRAY of
// { participant: { name }, words: [{ text, start_timestamp, end_timestamp }] }
// segments. Also tolerate { transcript: [...] } and { text: "..." } shapes.
function renderTranscript(j) {
  if (!j) return '';
  if (typeof j === 'string') return j;
  if (typeof j.text === 'string') return j.text;
  const segments = Array.isArray(j)
    ? j
    : Array.isArray(j.transcript) ? j.transcript : null;
  if (!segments) return JSON.stringify(j);
  return segments
    .map((seg) => {
      const speaker = seg?.participant?.name ?? seg?.speaker ?? seg?.participant?.id ?? '';
      let text;
      if (typeof seg?.text === 'string') text = seg.text;
      else if (Array.isArray(seg?.words))
        text = seg.words.map((w) => w?.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
      else text = '';
      if (!text) return '';
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Butterbase /ai/meetings prepends `app_` to every user-supplied metadata
// key on storage. A subsequent restore that re-supplied already-prefixed
// keys can land as `app_app_*`. Read all reasonable variants.
function readMeta(metadata, key) {
  if (!metadata) return null;
  return metadata[key]
    ?? metadata[`app_${key}`]
    ?? metadata[`app_app_${key}`]
    ?? null;
}

async function updateMeetingStatus(ctx, meetingId, patch) {
  const meeting = await ctx.substrate.getEntity(meetingId).catch(() => null);
  if (!meeting) return;
  const merged = { ...(meeting.attrs ?? {}), ...patch };
  try {
    await ctx.substrate.propose('update_entity', {
      id: meetingId, attrs: merged, display_name: meeting.display_name,
    });
  } catch (e) {
    console.warn('update_entity failed', String(e?.message ?? e));
  }
}

async function resolveOwnerUserId(ctx, workspaceId) {
  const r = await ctx.db.query(
    'SELECT owner_user_id FROM workspaces WHERE id = $1 LIMIT 1',
    [workspaceId],
  );
  return r.rows[0]?.owner_user_id ?? null;
}

// ctx.invoke bypasses the HTTP edge entirely — no Bearer match, no
// X-Butterbase-As-User impersonation, no env-key alignment. The receiver
// (ingest-meeting-transcript) writes via per-app ctx.substrate, so end-user
// identity isn't required to persist the artifact.
async function routeTranscriptToIngest(ctx, { meetingId, transcript, durationSeconds }) {
  const res = await ctx.invoke('ingest-meeting-transcript', {
    meeting_id: meetingId,
    transcript_text: transcript,
    duration_seconds: durationSeconds,
    external_system: 'butterbase-ai-meetings',
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data, raw: text };
}

export async function handler(req, ctx) {
  console.log('notetaker-webhook hit', JSON.stringify({
    method: req.method,
    event: req.headers.get('x-bb-event'),
    hasSig: !!req.headers.get('x-bb-signature'),
    ua: req.headers.get('user-agent'),
  }));

  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  const secret = ctx.env.NOTETAKER_WEBHOOK_SECRET;
  if (!secret) {
    console.error('NOTETAKER_WEBHOOK_SECRET not configured');
    return jsonResponse(500, { error: 'webhook_not_configured' });
  }

  const rawBody = await req.text();
  const event = req.headers.get('x-bb-event') ?? '';
  const sig = req.headers.get('x-bb-signature') ?? '';
  if (!event || !sig) {
    console.warn('notetaker-webhook missing_headers', JSON.stringify({ event, hasSig: !!sig }));
    return jsonResponse(400, { error: 'missing_headers' });
  }

  const expected = `v1,${await hmacBase64(secret, rawBody)}`;
  if (!timingSafeEqual(expected, sig)) {
    console.warn('notetaker-webhook invalid_signature', JSON.stringify({ event, bodyLen: rawBody.length }));
    return jsonResponse(401, { error: 'invalid_signature' });
  }

  let payload;
  try { payload = JSON.parse(rawBody); } catch { return jsonResponse(400, { error: 'invalid_json' }); }

  const botId = payload?.data?.bot?.id ?? null;
  const metadata = payload?.data?.bot?.metadata ?? {};
  const meetingId = readMeta(metadata, 'meeting_entity_id');
  const workspaceId = readMeta(metadata, 'workspace_id');

  console.log('notetaker-webhook event accepted', JSON.stringify({
    event, botId, meetingId, workspaceId,
  }));

  if (!botId || !meetingId) {
    console.warn('notetaker-webhook missing metadata, ignoring', JSON.stringify({ botId, meetingId, metadata }));
    return jsonResponse(200, { ok: true, ignored: 'missing_metadata' });
  }

  const eventId = payload?.id ?? payload?.event_id ?? `${event}:${botId}`;
  if (!(await ctx.idempotency.claim(eventId, { scope: 'notetaker-webhook' }))) {
    return jsonResponse(200, { ok: true, duplicate: true });
  }

  if (event === 'bot.in_call_recording') {
    await updateMeetingStatus(ctx, meetingId, { notetaker_status: 'recording' });
    return jsonResponse(200, { ok: true });
  }
  if (event === 'bot.fatal' || event === 'transcript.failed') {
    await updateMeetingStatus(ctx, meetingId, {
      notetaker_status: 'failed',
      notetaker_error: payload?.data?.error ?? event,
      notetaker_failed_at: new Date().toISOString(),
    });
    return jsonResponse(200, { ok: true });
  }

  if (event !== 'transcript.done') {
    return jsonResponse(200, { ok: true, event });
  }

  const bot = await getBot(ctx, botId);
  if (!bot) return jsonResponse(502, { error: 'bot_fetch_failed', bot_id: botId });

  const transcriptUrl = bot?.transcriptUrl ?? bot?.transcript_url ?? null;
  if (!transcriptUrl) {
    await updateMeetingStatus(ctx, meetingId, { notetaker_status: 'failed', notetaker_error: 'no_transcript_url' });
    return jsonResponse(502, { error: 'no_transcript_url', bot_id: botId });
  }

  const transcript = await fetchTranscriptText(ctx, transcriptUrl);
  if (!transcript || transcript.trim().length < 50) {
    await updateMeetingStatus(ctx, meetingId, { notetaker_status: 'failed', notetaker_error: 'empty_transcript' });
    return jsonResponse(502, { error: 'empty_transcript', bot_id: botId });
  }

  // dispatched_by is informational (audit metadata) — only trust it if it
  // looks like a UUID. A prior one-off restore stamped the literal string
  // "claude-mcp-restore" which would 401 downstream auth if we passed it on.
  let asUserId = readMeta(metadata, 'dispatched_by');
  if (typeof asUserId !== 'string' || !UUID_RE.test(asUserId)) asUserId = null;
  if (!asUserId && workspaceId) asUserId = await resolveOwnerUserId(ctx, workspaceId);
  // asUserId may still be null — that's fine, ingest no longer requires it.

  const durationSeconds = typeof bot?.durationSeconds === 'number'
    ? bot.durationSeconds
    : typeof bot?.duration_seconds === 'number' ? bot.duration_seconds : undefined;

  const ingest = await routeTranscriptToIngest(ctx, {
    meetingId, transcript, durationSeconds,
  });
  if (!ingest.ok) {
    await updateMeetingStatus(ctx, meetingId, {
      notetaker_status: 'failed',
      notetaker_error: `ingest_failed:${ingest.status}`,
    });
    return jsonResponse(502, { error: 'ingest_failed', detail: ingest.data ?? ingest.raw?.slice?.(0, 300) });
  }

  return jsonResponse(200, {
    ok: true,
    meeting_id: meetingId,
    source_artifact_id: ingest.data?.source_artifact_id ?? null,
  });
}

