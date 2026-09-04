function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req, ctx) {
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });
  // ctx.user is populated for HTTP dashboard callers; absent for internal
  // ctx.invoke callers (ingest-calendar's stale-bot cleanup). We write via
  // per-app ctx.substrate, so end-user identity isn't required.

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const meetingId = typeof body?.meeting_id === 'string' ? body.meeting_id : '';
  if (!meetingId) return jsonResponse(400, { error: 'meeting_id required' });

  const meeting = await ctx.substrate.getEntity(meetingId).catch(() => null);
  if (!meeting) return jsonResponse(404, { error: 'not_found' });

  const meetingAttrs = meeting.attrs ?? {};
  const botId = meetingAttrs.notetaker_bot_id ?? null;

  let deleteStatus = null;
  if (botId) {
    const res = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/ai/meetings/${botId}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
      },
    );
    deleteStatus = res.status;
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '');
      console.warn('ai/meetings DELETE failed', res.status, detail.slice(0, 200));
    }
  }

  const merged = { ...meetingAttrs };
  delete merged.notetaker_bot_id;
  delete merged.notetaker_status;
  delete merged.notetaker_dispatched_at;
  delete merged.notetaker_completed_at;
  delete merged.notetaker_error;
  delete merged.notetaker_failed_at;

  try {
    await ctx.substrate.propose('update_entity', {
      id: meetingId, attrs: merged, display_name: meeting.display_name,
    });
  } catch (e) {
    return jsonResponse(502, { error: 'substrate_update_failed', detail: String(e?.message ?? e) });
  }

  return jsonResponse(200, {
    ok: true,
    meeting_id: meetingId,
    bot_id: botId,
    bot_delete_status: deleteStatus,
  });
}

