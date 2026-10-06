function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const workspaceId = body?.workspace_id ?? null;
  if (!workspaceId) return json(400, { error: 'workspace_id required' });

  const mem = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, ctx.user.id],
  );
  if (mem.rows.length === 0) return json(403, { error: 'not_a_member' });

  const result = { migrated: 0, skipped_already_migrated: 0, failed: 0, errors: [] };

  const events = await ctx.substrate.findEntities({ type: 'event', limit: 500 }).catch(() => []);
  const alreadyMigrated = new Set();
  for (const e of events ?? []) {
    const src = e.attrs?.migrated_from_crm_id;
    if (typeof src === 'string') alreadyMigrated.add(src);
  }

  const meetingsRes = await ctx.db.query(
    `SELECT id, workspace_id, title, starts_at, ends_at, location, notes,
            company_id, deal_id, external_event_id,
            ai_summary, ai_summary_at, ai_action_items, ai_briefing, ai_briefing_at,
            created_at, updated_at
       FROM meetings
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  const meetings = meetingsRes.rows;

  if (meetings.length === 0) {
    return json(200, { ok: true, ...result, total_in_crm: 0 });
  }

  const meetingIds = meetings.map((m) => m.id);

  const attendeesRes = await ctx.db.query(
    `SELECT ma.meeting_id, ma.response, ma.external_email,
            p.id AS person_id, p.email, p.first_name, p.last_name,
            p.substrate_entity_id
       FROM meeting_attendees ma
       LEFT JOIN people p ON p.id = ma.person_id
      WHERE ma.meeting_id = ANY($1::uuid[])`,
    [meetingIds],
  );
  const attendeesByMeeting = new Map();
  for (const a of attendeesRes.rows) {
    if (!attendeesByMeeting.has(a.meeting_id)) attendeesByMeeting.set(a.meeting_id, []);
    attendeesByMeeting.get(a.meeting_id).push(a);
  }

  const cfvRes = await ctx.db.query(
    `SELECT entity_id, field_id, value_text, value_number, value_date, value_bool, value_json
       FROM custom_field_values
      WHERE workspace_id = $1
        AND object_type = 'meetings'
        AND entity_id = ANY($2::uuid[])`,
    [workspaceId, meetingIds],
  );
  const cfvByMeeting = new Map();
  for (const cf of cfvRes.rows) {
    if (!cfvByMeeting.has(cf.entity_id)) cfvByMeeting.set(cf.entity_id, {});
    const obj = cfvByMeeting.get(cf.entity_id);
    const val = cf.value_text ?? cf.value_number ?? cf.value_date ?? cf.value_bool ?? cf.value_json;
    if (val !== null && val !== undefined) obj[cf.field_id] = val;
  }

  const companyIds = meetings.map((m) => m.company_id).filter(Boolean);
  const dealIds = meetings.map((m) => m.deal_id).filter(Boolean);
  const companySubMap = new Map();
  const dealSubMap = new Map();
  if (companyIds.length > 0) {
    const r = await ctx.db.query(
      `SELECT id, substrate_entity_id FROM companies WHERE id = ANY($1::uuid[])`,
      [companyIds],
    );
    for (const c of r.rows) if (c.substrate_entity_id) companySubMap.set(c.id, c.substrate_entity_id);
  }
  if (dealIds.length > 0) {
    const r = await ctx.db.query(
      `SELECT id, substrate_entity_id FROM deals WHERE id = ANY($1::uuid[])`,
      [dealIds],
    );
    for (const d of r.rows) if (d.substrate_entity_id) dealSubMap.set(d.id, d.substrate_entity_id);
  }

  for (const m of meetings) {
    if (alreadyMigrated.has(m.id)) {
      result.skipped_already_migrated++;
      continue;
    }
    try {
      const attendees = attendeesByMeeting.get(m.id) ?? [];
      const attendeeEntityIds = [];
      const attendeeMeta = [];
      for (const a of attendees) {
        const subId = a.substrate_entity_id;
        if (!subId) continue;
        if (!attendeeEntityIds.includes(subId)) {
          attendeeEntityIds.push(subId);
          attendeeMeta.push({
            entity_id: subId,
            email: a.email ?? a.external_email ?? null,
            response: a.response ?? 'pending',
          });
        }
      }

      const customFields = cfvByMeeting.get(m.id) ?? {};

      const attrs = {
        workspace_id: workspaceId,
        title: m.title,
        starts_at: m.starts_at,
        ends_at: m.ends_at ?? null,
        location: m.location ?? null,
        notes: m.notes ?? null,
        company_id: m.company_id ? (companySubMap.get(m.company_id) ?? null) : null,
        deal_id: m.deal_id ? (dealSubMap.get(m.deal_id) ?? null) : null,
        external_event_id: m.external_event_id ?? null,
        ai_summary: m.ai_summary ?? null,
        ai_summary_at: m.ai_summary_at ?? null,
        ai_action_items: m.ai_action_items ?? null,
        ai_briefing: m.ai_briefing ?? null,
        ai_briefing_at: m.ai_briefing_at ?? null,
        migrated_from_crm_id: m.id,
        crm_created_at: m.created_at,
        crm_updated_at: m.updated_at,
      };
      if (Object.keys(customFields).length > 0) attrs.custom_fields = customFields;
      if (attendeeEntityIds.length > 0) {
        attrs.attendee_entity_ids = attendeeEntityIds;
        attrs.attendees = attendeeMeta;
      }

      for (const k of Object.keys(attrs)) if (attrs[k] === null) delete attrs[k];

      await ctx.substrate.propose('upsert_entity', {
        type: 'event',
        display_name: m.title || 'Untitled meeting',
        attrs,
      });
      result.migrated++;
    } catch (e) {
      result.failed++;
      result.errors.push({ meeting_id: m.id, detail: String(e?.message ?? e).slice(0, 240) });
      if (result.errors.length > 20) {
        result.errors.push({ meeting_id: '...', detail: 'further errors truncated' });
        break;
      }
    }
  }

  return json(200, {
    ok: result.failed === 0,
    workspace_id: workspaceId,
    total_in_crm: meetings.length,
    ...result,
  });
}

