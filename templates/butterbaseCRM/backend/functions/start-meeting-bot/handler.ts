const MEETING_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)\/[^\s<>"')]+/i;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function extractMeetingUrl(meetingAttrs) {
  const candidates = [
    meetingAttrs?.meeting_url,
    meetingAttrs?.location,
    meetingAttrs?.notes,
    meetingAttrs?.description,
  ].filter((s) => typeof s === 'string' && s.length > 0);
  for (const c of candidates) {
    const m = c.match(MEETING_URL_RE);
    if (m) return m[0];
  }
  return null;
}

async function dispatchBot(ctx, meetingUrl, botName, metadata) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/ai/meetings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
    },
    body: JSON.stringify({
      meetingUrl,
      transcript: true,
      recording: 'mp4',
      botName,
      metadata: { ...metadata, bot_name: botName },
    }),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data, raw: text };
}

export async function handler(req, ctx) {
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { body = {}; }

  // ctx.user is populated for HTTP dashboard callers; absent for internal
  // ctx.invoke callers (ingest-calendar), who have already been gated upstream.
  // dispatched_by is recorded in metadata for audit but is non-load-bearing —
  // resolveOwnerUserId in notetaker-webhook will fall back to the workspace
  // owner when this is missing.
  const effectiveUserId = ctx.user?.id ?? null;

  const meetingId = typeof body?.meeting_id === 'string' ? body.meeting_id : '';
  if (!meetingId) return jsonResponse(400, { error: 'meeting_id required' });

  const meeting = await ctx.substrate.getEntity(meetingId).catch(() => null);
  if (!meeting) return jsonResponse(404, { error: 'not_found' });

  const meetingAttrs = meeting.attrs ?? {};
  const workspaceId = meetingAttrs.workspace_id ?? null;
  if (!workspaceId) return jsonResponse(400, { error: 'meeting_missing_workspace_id' });

  if (meetingAttrs.notetaker_bot_id && meetingAttrs.notetaker_status !== 'failed') {
    return jsonResponse(200, {
      ok: true,
      meeting_id: meetingId,
      bot_id: meetingAttrs.notetaker_bot_id,
      status: meetingAttrs.notetaker_status ?? 'pending_transcript',
      already_dispatched: true,
    });
  }

  const meetingUrl = extractMeetingUrl(meetingAttrs);
  if (!meetingUrl) {
    return jsonResponse(400, { error: 'no_meeting_url', detail: 'No Zoom/Meet/Teams/Webex URL found in attrs.meeting_url / location / notes' });
  }

  const nameRow = await ctx.db.query(
    'SELECT notetaker_name FROM sync_settings WHERE workspace_id = $1',
    [workspaceId],
  );
  const botName = (typeof nameRow.rows[0]?.notetaker_name === 'string' && nameRow.rows[0].notetaker_name.trim())
    ? nameRow.rows[0].notetaker_name.trim().slice(0, 64)
    : 'Notetaker';

  const dispatched = await dispatchBot(ctx, meetingUrl, botName, {
    meeting_entity_id: meetingId,
    workspace_id: String(workspaceId),
    ...(effectiveUserId ? { dispatched_by: effectiveUserId } : {}),
  });

  if (!dispatched.ok) {
    return jsonResponse(502, {
      error: 'ai_meetings_dispatch_failed',
      status: dispatched.status,
      detail: dispatched.data ?? dispatched.raw?.slice?.(0, 300),
    });
  }

  const botId = dispatched.data?.id ?? null;
  if (!botId) {
    return jsonResponse(502, { error: 'ai_meetings_no_bot_id', detail: dispatched.data });
  }

  const merged = { ...meetingAttrs };
  merged.notetaker_bot_id = botId;
  merged.notetaker_status = 'pending_transcript';
  merged.notetaker_dispatched_at = new Date().toISOString();
  delete merged.notetaker_completed_at;

  try {
    await ctx.substrate.propose('update_entity', {
      id: meetingId,
      attrs: merged,
      display_name: meeting.display_name,
    });
  } catch (e) {
    console.warn('substrate update_entity failed', String(e?.message ?? e));
  }

  return jsonResponse(200, {
    ok: true,
    meeting_id: meetingId,
    bot_id: botId,
    status: 'pending_transcript',
    meeting_url: meetingUrl,
  });
}

