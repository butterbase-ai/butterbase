// crm-upsert-meeting — single substrate-primary write path for meetings.
//
// Meeting metadata lives as a substrate entity (type='event'). Transcript
// content lives in a separate source_artifact (kind='meeting_notes') keyed by
// this entity id — written by ingest-meeting-transcript, not here.
//
// Dedupe order: explicit substrate_entity_id → canonical_keys.external_event_id.
// The canonical-keys path uses propose('upsert_entity', { canonical_keys: ... })
// as a probe: substrate dedupes natively and the verdict returns `was_insert`
// + `before_attrs`. On match we follow up with patch_entity to merge prior
// attrs back in (upsert_entity REPLACES attrs wholesale).

type Source = 'gmail' | 'calendar' | 'ui' | 'agent' | 'substrate' | 'import' | 'notetaker';

interface AttendeeInput {
  email: string;
  name?: string | null;
  response?: 'accepted' | 'declined' | 'tentative' | 'pending';
  substrate_entity_id?: string | null;
}

interface Body {
  workspace_id: string;
  source: Source;
  attrs: {
    title?: string | null;
    starts_at?: string | null;
    ends_at?: string | null;
    location?: string | null;
    notes?: string | null;
    meeting_url?: string | null;
    company_id?: string | null;
    deal_id?: string | null;
    external_event_id?: string | null;
    ai_summary?: string | null;
    ai_summary_at?: string | null;
    ai_action_items?: any;
    ai_briefing?: string | null;
    ai_briefing_at?: string | null;
    notetaker_status?: 'idle' | 'pending_transcript' | 'recording' | 'done' | 'failed';
    notetaker_artifact_id?: string | null;
    custom_fields?: Record<string, any>;
  };
  attendees?: AttendeeInput[];
  substrate_entity_id?: string | null;
  clear_fields?: string[];
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const CLEARABLE = new Set<string>([
  'ends_at', 'location', 'notes', 'meeting_url', 'company_id', 'deal_id', 'external_event_id',
  'ai_summary', 'ai_summary_at', 'ai_action_items', 'ai_briefing', 'ai_briefing_at',
  'notetaker_status', 'notetaker_artifact_id',
]);

const MERGEABLE_TOP_LEVEL = [
  'workspace_id',
  'starts_at', 'ends_at', 'location', 'notes', 'meeting_url',
  'company_id', 'deal_id', 'external_event_id',
  'ai_summary', 'ai_summary_at', 'ai_action_items', 'ai_briefing', 'ai_briefing_at',
  'notetaker_status', 'notetaker_artifact_id',
] as const;

function extractEntityId(result: any): string | null {
  if (!result) return null;
  return result.entity_id ?? result.id ?? result.entity?.id ?? result.entity?.entity_id ?? null;
}

function mergeAttrs(opts: {
  prior: Record<string, any>;
  bodyAttrs: Body['attrs'] & { _custom_fields_replace?: boolean };
  newAttendeeIds: string[];
  newAttendeeMeta: Array<{ entity_id: string; email: string; response: string }>;
  clearFields: string[];
  workspaceId: string;
}) {
  const { prior, bodyAttrs, newAttendeeIds, newAttendeeMeta, clearFields, workspaceId } = opts;
  const merged: Record<string, any> = { ...prior };

  if (!merged.workspace_id) merged.workspace_id = workspaceId;

  for (const key of MERGEABLE_TOP_LEVEL) {
    const v = (bodyAttrs as any)[key];
    if (v === undefined) continue;
    if (v === null) continue;
    if (key === 'workspace_id') continue;
    merged[key] = v;
  }

  if (bodyAttrs.custom_fields && typeof bodyAttrs.custom_fields === 'object') {
    if ((bodyAttrs as any)._custom_fields_replace) {
      merged.custom_fields = { ...bodyAttrs.custom_fields };
    } else {
      merged.custom_fields = { ...(merged.custom_fields ?? {}), ...bodyAttrs.custom_fields };
    }
  }

  const prevAttendeeIds: string[] = Array.isArray(merged.attendee_entity_ids) ? merged.attendee_entity_ids : [];
  const prevAttendeeMeta: any[] = Array.isArray(merged.attendees) ? merged.attendees : [];
  if (newAttendeeIds.length > 0) {
    merged.attendee_entity_ids = Array.from(new Set([...prevAttendeeIds, ...newAttendeeIds]));
    const metaById = new Map<string, any>();
    for (const m of prevAttendeeMeta) if (m?.entity_id) metaById.set(m.entity_id, m);
    for (const m of newAttendeeMeta) metaById.set(m.entity_id, m);
    merged.attendees = Array.from(metaById.values());
  }

  for (const f of clearFields) delete merged[f];

  const incomingTitle = bodyAttrs.title ?? null;
  if (incomingTitle) merged.title = incomingTitle;

  return merged;
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });

  let body: Body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  if (!body?.workspace_id) return json(400, { error: 'workspace_id required' });
  if (!body?.source) return json(400, { error: 'source required' });
  if (!body?.attrs || typeof body.attrs !== 'object') return json(400, { error: 'attrs required' });

  const clearFields: string[] = Array.isArray(body.clear_fields) ? body.clear_fields : [];
  for (const f of clearFields) {
    if (!CLEARABLE.has(f)) return json(400, { error: `${f} is not clearable` });
  }

  // HTTP dashboard callers have ctx.user populated by the platform; gate them
  // on workspace membership. Internal function-to-function callers reach us
  // via ctx.invoke without ctx.user — they've already been gated upstream
  // (ingest-calendar verifies membership before invoking us). We write via
  // ctx.substrate, which is per-app and needs no end-user identity.
  if (ctx.user?.id) {
    const mem = await ctx.db.query(
      'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
      [body.workspace_id, ctx.user.id],
    );
    if (mem.rows.length === 0) return json(403, { error: 'not_a_member' });
  }

  const attendeeInputs = (body.attendees ?? []).filter((a) => a?.email);
  const attendeeEntityIds: string[] = [];
  const attendeeMeta: Array<{ entity_id: string; email: string; response: string }> = [];

  if (attendeeInputs.length > 0) {
    const everyAttendeeHasId = attendeeInputs.every((a) => typeof a.substrate_entity_id === 'string' && a.substrate_entity_id);

    if (everyAttendeeHasId) {
      for (const a of attendeeInputs) {
        const email = a.email.toLowerCase().trim();
        const id = a.substrate_entity_id as string;
        if (!attendeeEntityIds.includes(id)) {
          attendeeEntityIds.push(id);
          attendeeMeta.push({ entity_id: id, email, response: a.response ?? 'pending' });
        }
      }
    } else {
      const allPersons = await ctx.substrate.findEntities({ type: 'person', limit: 200 }).catch(() => []);
      const personByEmail = new Map<string, any>();
      for (const p of allPersons ?? []) {
        const email = String(p.attrs?.email ?? p.primary_email ?? '').toLowerCase().trim();
        if (email) personByEmail.set(email, p);
      }
      for (const a of attendeeInputs) {
        const email = a.email.toLowerCase().trim();
        if (!email) continue;
        let entity: any = a.substrate_entity_id ? { id: a.substrate_entity_id } : personByEmail.get(email);
        if (!entity) {
          const name = a.name ?? null;
          const verdict = await ctx.substrate.propose('upsert_entity', {
            type: 'person',
            display_name: name || email,
            canonical_keys: { email },
            attrs: {
              email,
              ...(name
                ? {
                    first_name: name.split(' ')[0],
                    last_name: name.split(' ').slice(1).join(' ') || null,
                  }
                : {}),
            },
          }).catch(() => null);
          const newId = extractEntityId(verdict?.result);
          if (newId) {
            entity = { id: newId };
            personByEmail.set(email, entity);
          }
        }
        if (entity?.id && !attendeeEntityIds.includes(entity.id)) {
          attendeeEntityIds.push(entity.id);
          attendeeMeta.push({ entity_id: entity.id, email, response: a.response ?? 'pending' });
        }
      }
    }
  }

  let existingId: string | null = null;
  let priorAttrs: Record<string, any> = {};
  let priorDisplayName: string | null = null;
  let created = false;

  if (body.substrate_entity_id) {
    const ent = await ctx.substrate.getEntity(body.substrate_entity_id).catch(() => null);
    if (ent?.id) {
      existingId = ent.id;
      priorAttrs = ent.attrs ?? {};
      priorDisplayName = ent.display_name ?? null;
    }
  }

  let verdict: any = null;

  if (!existingId && body.attrs.external_event_id) {
    const probeAttrs: Record<string, any> = { workspace_id: body.workspace_id };
    if (body.attrs.external_event_id) probeAttrs.external_event_id = body.attrs.external_event_id;
    if (body.attrs.title) probeAttrs.title = body.attrs.title;
    if (body.attrs.starts_at) probeAttrs.starts_at = body.attrs.starts_at;
    if (body.attrs.ends_at) probeAttrs.ends_at = body.attrs.ends_at;
    if (body.attrs.location) probeAttrs.location = body.attrs.location;
    if (body.attrs.notes) probeAttrs.notes = body.attrs.notes;
    if (body.attrs.meeting_url) probeAttrs.meeting_url = body.attrs.meeting_url;

    const probeDisplayName = body.attrs.title ?? 'Untitled meeting';

    try {
      verdict = await ctx.substrate.propose('upsert_entity', {
        type: 'event',
        canonical_keys: { external_event_id: body.attrs.external_event_id },
        display_name: probeDisplayName,
        attrs: probeAttrs,
      });
    } catch (e: any) {
      return json(502, { error: 'substrate_propose_failed', detail: String(e?.message ?? e) });
    }

    const r = verdict?.result ?? {};
    existingId = r.entity_id ?? null;
    if (r.was_insert === false) {
      priorAttrs = r.before_attrs ?? {};
      priorDisplayName = r.before_display_name ?? null;
      created = false;
    } else {
      created = true;
    }
  }

  if (!existingId && !body.attrs.starts_at && !body.substrate_entity_id) {
    return json(400, { error: 'starts_at required for new meeting' });
  }

  const merged = mergeAttrs({
    prior: priorAttrs,
    bodyAttrs: body.attrs as any,
    newAttendeeIds: attendeeEntityIds,
    newAttendeeMeta: attendeeMeta,
    clearFields,
    workspaceId: body.workspace_id,
  });

  const displayName =
    body.attrs.title ?? priorDisplayName ?? merged.title ?? 'Untitled meeting';

  try {
    if (existingId) {
      verdict = await ctx.substrate.propose('patch_entity', {
        id: existingId,
        attrs_patch: merged,
        display_name: displayName,
      });
    } else {
      verdict = await ctx.substrate.propose('upsert_entity', {
        type: 'event',
        display_name: displayName,
        attrs: merged,
      });
      existingId = extractEntityId(verdict?.result);
      created = true;
    }
  } catch (e: any) {
    return json(502, { error: 'substrate_propose_failed', detail: String(e?.message ?? e) });
  }

  return json(200, {
    id: existingId,
    created,
    verdict,
  });
}

