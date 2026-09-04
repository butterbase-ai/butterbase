const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

const NOREPLY_LOCAL = /^(no[._-]?reply|donot[._-]?reply|do[._-]?not[._-]?reply|notreply|reply[._-]?not|unreply|no[._-]?response)\b/i;
const AUTOMATED_LOCAL = /^(mailer[._-]?daemon|postmaster|webmaster|abuse|bounces?|returns?|complaints?|auto([._-]?reply|[._-]?response|[._-]?responder)?|autoresponse|autoresponder|automated|notifications?|notify|alerts?|updates?|digest|news|newsletter|mailings?|marketing|promo|promotions|offers|deals|campaigns?|broadcast|daemon|robot|bot|service|system)\b/i;
const ROLE_LOCAL = /^(info|hello|contact|support|help(desk)?|admin|sales|billing|accounts?|accounting|hr|careers|jobs|recruiting|press|media|legal|privacy|security|feedback|survey|office|team|inquiries|enquiries)\b/i;
const BULK_SUBDOMAIN = /^(bounce|bounces|bounced|return|returns|mail|mailer|email|em|e|smtp|mta|relay|click|link|links|track|t|r|news|marketing|notify|notifications|updates|info)\./i;
const ESP_DOMAINS = new Set([
  'sendgrid.net', 'sendgrid.com',
  'mailgun.org', 'mailgun.net',
  'postmarkapp.com', 'pm-bounces.com',
  'mandrillapp.com', 'mcsv.net', 'mcdlv.net', 'mailchimpapp.net',
  'sparkpostmail.com', 'sparkpost.com',
  'amazonses.com',
  'sendinblue.com', 'sibsmtp.com', 'brevo.com',
  'hubspotemail.net', 'hsforms.net',
  'intercom-mail.com',
  'iterable.com', 'iterableapi.com',
  'klaviyomail.com',
  'salesforce-experience.com',
]);

function classifySender({ email }) {
  if (!email) return 'drop';
  const lower = email.toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return 'drop';
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  const baseLocal = local.split('+')[0];
  if (NOREPLY_LOCAL.test(baseLocal)) return 'drop';
  if (AUTOMATED_LOCAL.test(baseLocal)) return 'drop';
  if (ESP_DOMAINS.has(domain)) return 'drop';
  for (const esp of ESP_DOMAINS) if (domain.endsWith('.' + esp)) return 'drop';
  if (BULK_SUBDOMAIN.test(domain)) return 'drop';
  if (ROLE_LOCAL.test(baseLocal)) return 'role';
  return null;
}

const DAYS_FORWARD = 30;
const FIRST_RUN_DAYS_BACK = 7;
const OVERLAP_HOURS = 1;

const MEETING_URL_RE =
  /https?:\/\/(?:[a-z0-9-]+\.)*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)\/[^\s<>"')]+/i;

const DISPATCH_GRACE_PAST_MS = 5 * 60 * 1000;
const DISPATCH_LOOKAHEAD_MS = 10 * 60 * 1000;

function pickMeetingUrl(ev, location, notes) {
  if (typeof ev?.hangoutLink === 'string' && MEETING_URL_RE.test(ev.hangoutLink)) {
    return ev.hangoutLink;
  }
  const entryPoints = ev?.conferenceData?.entryPoints;
  if (Array.isArray(entryPoints)) {
    for (const ep of entryPoints) {
      if (ep?.entryPointType && ep.entryPointType !== 'video') continue;
      const uri = typeof ep?.uri === 'string' ? ep.uri : null;
      if (uri && MEETING_URL_RE.test(uri)) return uri;
    }
  }
  for (const s of [location, notes]) {
    if (typeof s !== 'string') continue;
    const m = s.match(MEETING_URL_RE);
    if (m) return m[0];
  }
  return null;
}

export async function handler(req, ctx) {
  if (!ctx.substrate) {
    return new Response(JSON.stringify({ error: 'substrate_not_linked' }), {
      status: 503, headers: { 'content-type': 'application/json' },
    });
  }
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  const userId = ctx.user.id;
  const authHeader = req.headers.get('authorization') ?? '';

  let body = {};
  try { body = await req.json(); } catch {}
  const requestedWs = typeof body?.workspace_id === 'string' ? body.workspace_id : null;

  let workspaceId;
  if (requestedWs) {
    const m = await ctx.db.query(
      'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
      [requestedWs, userId],
    );
    if (m.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'not_a_member' }), {
        status: 403, headers: { 'content-type': 'application/json' },
      });
    }
    workspaceId = requestedWs;
  } else {
    const m = await ctx.db.query(
      'SELECT workspace_id FROM memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
      [userId],
    );
    if (m.rows.length === 0) {
      return new Response(JSON.stringify({ error: 'no_workspace' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    workspaceId = m.rows[0].workspace_id;
  }

  const lockKey = `lock:ingest-calendar:${workspaceId}`;
  const runId = crypto.randomUUID();
  const acquired = await ctx.kv.setnx(lockKey, runId, { ttl: 900 });
  if (!acquired) {
    const holder = await ctx.kv.get(lockKey).catch(() => null);
    return new Response(JSON.stringify({
      ok: true, skipped: 'lock_held', workspace_id: workspaceId, holder,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  try {
    const summary = await runIngest(ctx, authHeader, workspaceId, userId);
    return new Response(JSON.stringify({ ok: true, workspace_id: workspaceId, ...summary }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error('ingest-calendar fatal', detail);
    await writeError(ctx, workspaceId, 'calendar', detail).catch(() => {});
    return new Response(JSON.stringify({ ok: false, workspace_id: workspaceId, error: detail }), {
      status: 500, headers: { 'content-type': 'application/json' },
    });
  } finally {
    try {
      const current = await ctx.kv.get(lockKey);
      if (current === runId) await ctx.kv.del(lockKey);
    } catch {}
  }
}

async function runIngest(ctx, authHeader, workspaceId, userId) {
  const stateRow = await ctx.db.query(
    'SELECT last_synced_at FROM integration_state WHERE workspace_id = $1 AND kind = $2',
    [workspaceId, 'calendar'],
  );
  const lastSyncedAt = stateRow.rows[0]?.last_synced_at
    ? new Date(stateRow.rows[0].last_synced_at)
    : null;

  const now = new Date();
  const time_min = lastSyncedAt
    ? new Date(lastSyncedAt.getTime() - OVERLAP_HOURS * 3600 * 1000).toISOString()
    : new Date(now.getTime() - FIRST_RUN_DAYS_BACK * 24 * 3600 * 1000).toISOString();
  const time_max = new Date(now.getTime() + DAYS_FORWARD * 24 * 3600 * 1000).toISOString();

  const params = {
    calendar_id: 'primary',
    single_events: true,
    max_results: 250,
    time_min,
    time_max,
  };

  let composioRes;
  try {
    composioRes = await composioExecute(ctx, authHeader, userId, 'GOOGLESUPER_FIND_EVENT', params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeError(ctx, workspaceId, 'calendar', msg);
    return { status: 'failed', stage: 'composio', error: msg };
  }

  if (!composioRes?.successful) {
    const detail = typeof composioRes?.error === 'string' ? composioRes.error : JSON.stringify(composioRes?.error ?? 'find_event_failed');
    await writeError(ctx, workspaceId, 'calendar', detail);
    return { status: 'failed', stage: 'composio', error: detail };
  }

  const events = extractEvents(composioRes.data);

  events.sort((a, b) => {
    const aT = pickDate(a?.start) ?? '9999';
    const bT = pickDate(b?.start) ?? '9999';
    return aT.localeCompare(bT);
  });

  console.log('[ingest-calendar] window', time_min, '..', time_max,
    'events=', events.length,
    'dataKeys=', Object.keys(composioRes.data ?? {}).slice(0, 12).join(','),
    'sampleEvent=', events[0] ? JSON.stringify({ id: events[0].id, status: events[0].status, summary: events[0].summary, hasStart: !!events[0].start }) : 'none');

  await ctx.db.query(
    `INSERT INTO integration_state (workspace_id, kind, cursor, last_synced_at, last_error, updated_at)
     VALUES ($1, $2, NULL, now(), NULL, now())
     ON CONFLICT (workspace_id, kind)
     DO UPDATE SET cursor = NULL, last_synced_at = now(), last_error = NULL, updated_at = now()`,
    [workspaceId, 'calendar'],
  );

  let upsertAttempts = 0, skippedCancelled = 0, skippedNoExtId = 0, skippedNoStart = 0;
  let droppedAutomated = 0, taggedRole = 0;
  let firstUpsertError = null;
  let firstSubstrateError = null;

  const settingsRow = await ctx.db.query(
    'SELECT notetaker_auto_enabled FROM sync_settings WHERE workspace_id = $1',
    [workspaceId],
  );
  const notetakerAuto = settingsRow.rows.length === 0
    ? true
    : settingsRow.rows[0]?.notetaker_auto_enabled !== false;
  const nowMs = Date.now();

  const companyByDomain = new Map();
  const personByEmail = new Map();

  // ---- Stale-bot sweep ----
  // Walk every substrate `event` with a pending notetaker bot in this
  // workspace and cancel any that have drifted away from the calendar truth:
  //   1. external_event_id missing from the freshly-fetched window AND the
  //      substrate starts_at lies inside (time_min, time_max) — deleted/declined/moved.
  //   2. fresh starts_at differs from substrate starts_at — rescheduled.
  //   3. fresh meeting_url differs from substrate meeting_url — URL swap.
  //   4. substrate starts_at > now + lookahead + 60s — pre-fix leftover.
  // Must run BEFORE the upsert loop so the URL-change comparison sees the
  // pre-patch substrate copy.
  let stale_cancelled = 0;
  try {
    const timeMinMs = new Date(time_min).getTime();
    const timeMaxMs = new Date(time_max).getTime();
    const freshIndex = new Map();
    for (const ev of events) {
      const extId = ev.id ?? ev.eventId ?? ev.iCalUID ?? null;
      if (!extId) continue;
      const startsAt = pickDate(ev.start);
      const evLocation = ev.location ?? null;
      const evNotes = ev.description ?? null;
      freshIndex.set(extId, {
        startsAt,
        meetingUrl: pickMeetingUrl(ev, evLocation, evNotes),
      });
    }

    const subEvents = await ctx.substrate.findEntities({ type: 'event', limit: 500 }).catch(() => []);
    for (const e of subEvents ?? []) {
      const attrs = e?.attrs ?? {};
      if (attrs.workspace_id && attrs.workspace_id !== workspaceId) continue;
      const botId = attrs.notetaker_bot_id;
      if (!botId) continue;
      const status = attrs.notetaker_status;
      if (status === 'done' || status === 'failed') continue;

      const extId = attrs.external_event_id ?? null;
      const startsAtMs = attrs.starts_at ? new Date(attrs.starts_at).getTime() : 0;
      const fresh = extId ? freshIndex.get(extId) : null;

      let reason = null;
      if (!fresh) {
        if (startsAtMs > timeMinMs && startsAtMs < timeMaxMs) reason = 'event_missing_from_calendar';
      } else if (fresh.startsAt !== attrs.starts_at) {
        reason = 'starts_at_changed';
      } else if ((fresh.meetingUrl ?? null) !== (attrs.meeting_url ?? null)) {
        reason = 'meeting_url_changed';
      } else if (startsAtMs > nowMs + DISPATCH_LOOKAHEAD_MS + 60_000) {
        reason = 'dispatched_outside_window';
      }

      if (reason) {
        try {
          await callFn(ctx, 'cancel-meeting-bot', { meeting_id: e.id });
          stale_cancelled++;
          console.log('[ingest-calendar] cancelled stale bot', JSON.stringify({
            meeting_id: e.id, bot_id: botId, reason, starts_at: attrs.starts_at,
          }));
        } catch (err) {
          console.warn('cancel-meeting-bot failed', e.id, String(err?.message ?? err));
        }
      }
    }
  } catch (err) {
    console.warn('[ingest-calendar] stale-bot sweep failed', String(err?.message ?? err));
  }

  for (const ev of events) {
    if (ev.status === 'cancelled') { skippedCancelled++; continue; }
    const externalId = ev.id ?? ev.eventId ?? ev.iCalUID ?? null;
    if (!externalId) { skippedNoExtId++; continue; }
    const title = ev.summary ?? ev.title ?? '(no title)';
    const startsAt = pickDate(ev.start);
    const endsAt = pickDate(ev.end);
    if (!startsAt) { skippedNoStart++; continue; }
    upsertAttempts++;
    const location = ev.location ?? null;
    const notes = ev.description ?? null;
    const meetingUrl = pickMeetingUrl(ev, location, notes);

    const rawAttendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    const resolved = [];
    for (const att of rawAttendees) {
      const email = (att?.email ?? '').toLowerCase();
      if (!email) continue;
      const displayName = att?.displayName ?? null;
      const response = mapResponseStatus(att?.responseStatus);

      const verdict = classifySender({ email });
      if (verdict === 'drop') { droppedAutomated++; continue; }
      const isRoleAccount = verdict === 'role';
      if (isRoleAccount) taggedRole++;

      let companyId = null;
      const rawDomain = email.split('@')[1] ?? null;
      if (rawDomain && !PUBLIC_EMAIL_DOMAINS.has(rawDomain)) {
        const { apexDomain, companyLabel } = deriveCompanyFromDomain(rawDomain);
        if (companyByDomain.has(apexDomain)) {
          companyId = companyByDomain.get(apexDomain);
        } else {
          try {
            companyId = await upsertCompanyEntity(ctx, { name: companyLabel, domain: apexDomain });
            if (companyId) companyByDomain.set(apexDomain, companyId);
          } catch (e) {
            const m = String(e?.message ?? e).slice(0, 200);
            console.warn('upsert company failed', m);
            if (!firstSubstrateError) firstSubstrateError = `company: ${m}`;
          }
        }
      }

      let personId = null;
      if (personByEmail.has(email)) {
        personId = personByEmail.get(email);
      } else {
        try {
          const { firstName, lastName } = splitName(displayName, email);
          personId = await upsertPersonEntity(ctx, {
            first_name: firstName,
            last_name: lastName,
            email,
            company_id: companyId,
            is_role_account: isRoleAccount,
          });
          if (personId) personByEmail.set(email, personId);
        } catch (e) {
          const m = String(e?.message ?? e).slice(0, 200);
          console.warn('upsert person failed', m);
          if (!firstSubstrateError) firstSubstrateError = `person: ${m}`;
        }
      }
      if (!personId) continue;
      resolved.push({ email, name: displayName, response, personId, companyId });
    }

    let meetingId = null;
    try {
      const res = await callFn(ctx, 'crm-upsert-meeting', {
        workspace_id: workspaceId,
        source: 'calendar',
        attrs: {
          title, starts_at: startsAt, ends_at: endsAt, location, notes,
          external_event_id: externalId,
          meeting_url: meetingUrl,
        },
        attendees: resolved.map((r) => ({
          email: r.email,
          name: r.name,
          response: r.response,
          substrate_entity_id: r.personId,
        })),
      });
      meetingId = res?.id ?? null;
    } catch (e) {
      const m = String(e?.message ?? e).slice(0, 200);
      console.warn('crm-upsert-meeting failed', m);
      if (!firstUpsertError) firstUpsertError = m;
      continue;
    }

    if (notetakerAuto && meetingId && meetingUrl) {
      const startsAtMs = startsAt ? new Date(startsAt).getTime() : 0;
      const inDispatchWindow =
        startsAtMs > nowMs - DISPATCH_GRACE_PAST_MS &&
        startsAtMs < nowMs + DISPATCH_LOOKAHEAD_MS;
      if (inDispatchWindow) {
        try {
          await callFn(ctx, 'start-meeting-bot', {
            meeting_id: meetingId,
          });
        } catch (e) {
          console.warn('start-meeting-bot dispatch failed', externalId, String(e?.message ?? e));
        }
      }
    }

    for (const r of resolved) {
      try {
        await callFn(ctx, 'crm-record-activity', {
          workspace_id: workspaceId,
          kind: 'meeting',
          entity_type: 'person',
          entity_id: r.personId,
          dedupe_key: `${externalId}:${r.email}`,
          payload: {
            event_id: externalId, meeting_id: meetingId,
            summary: title, start: startsAt, end: endsAt,
            location, response: r.response, company_id: r.companyId,
          },
          occurred_at: startsAt,
        });
      } catch (e) {
        console.warn('crm-record-activity failed', String(e?.message ?? e));
      }
    }
  }

  console.log('[ingest-calendar] done',
    'events=', events.length,
    'stale_cancelled=', stale_cancelled,
    'upsertAttempts=', upsertAttempts,
    'skippedCancelled=', skippedCancelled,
    'skippedNoExtId=', skippedNoExtId,
    'skippedNoStart=', skippedNoStart,
    'droppedAutomated=', droppedAutomated,
    'taggedRole=', taggedRole,
    'firstUpsertError=', firstUpsertError ?? 'none',
    'firstSubstrateError=', firstSubstrateError ?? 'none');

  const lastError = firstUpsertError
    ? JSON.stringify({ kind: 'upsert', msg: firstUpsertError, events: events.length, upsertAttempts }).slice(0, 500)
    : firstSubstrateError
      ? JSON.stringify({ kind: 'substrate', msg: firstSubstrateError, events: events.length }).slice(0, 500)
      : null;

  if (lastError) {
    await writeError(ctx, workspaceId, 'calendar', lastError);
  }

  return {
    status: 'ok',
    events: events.length,
    stale_cancelled,
    upsertAttempts,
    skippedCancelled,
    skippedNoExtId,
    skippedNoStart,
    droppedAutomated,
    taggedRole,
    firstUpsertError,
    firstSubstrateError,
  };
}

function extractEntityId(result) {
  if (!result) return null;
  return result.entity_id ?? result.id ?? result.entity?.id ?? result.entity?.entity_id ?? null;
}

async function upsertCompanyEntity(ctx, { name, domain }) {
  const verdict = await ctx.substrate.propose('upsert_entity', {
    type: 'company',
    display_name: name,
    canonical_keys: { domain },
    attrs: { name, domain },
  });
  return extractEntityId(verdict?.result);
}

async function upsertPersonEntity(ctx, { first_name, last_name, email, company_id, is_role_account }) {
  const full = [first_name, last_name].filter(Boolean).join(' ').trim();
  const attrs = { first_name, last_name, email, company_id };
  if (is_role_account) attrs.is_role_account = true;
  const verdict = await ctx.substrate.propose('upsert_entity', {
    type: 'person',
    display_name: full || email,
    primary_email: email,
    canonical_keys: { email },
    attrs,
  });
  return extractEntityId(verdict?.result);
}

async function callFn(ctx, fnName, payload) {
  const res = await ctx.invoke(fnName, payload);
  if (!res.ok) throw new Error(`${fnName} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function composioExecute(ctx, authHeader, userId, toolName, params) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body: JSON.stringify({ toolName, params, userId }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`composio ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`composio non-json: ${text.slice(0, 200)}`); }
}

function extractEvents(data) {
  if (!data) return [];
  if (Array.isArray(data?.event_data?.event_data)) return data.event_data.event_data;
  if (Array.isArray(data?.event_data)) return data.event_data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.events)) return data.events;
  if (Array.isArray(data.data?.items)) return data.data.items;
  if (Array.isArray(data.data?.events)) return data.data.events;
  if (Array.isArray(data)) return data;
  return [];
}

function pickDate(slot) {
  if (!slot) return null;
  if (typeof slot === 'string') return new Date(slot).toISOString();
  if (slot.dateTime) return new Date(slot.dateTime).toISOString();
  if (slot.date) return new Date(slot.date).toISOString();
  return null;
}

function mapResponseStatus(s) {
  if (s === 'accepted') return 'accepted';
  if (s === 'declined') return 'declined';
  if (s === 'tentative') return 'tentative';
  return 'pending';
}

const TWO_PART_TLDS = new Set([
  'co.uk','co.jp','co.kr','co.in','co.nz','co.za','co.id','co.il',
  'com.au','com.br','com.cn','com.hk','com.mx','com.ng','com.sg','com.tr','com.tw',
  'org.uk','net.au','ac.uk','gov.uk',
]);

function deriveCompanyFromDomain(rawDomain) {
  const domain = rawDomain.toLowerCase().replace(/^\.+|\.+$/g, '');
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 1) return { apexDomain: domain, companyLabel: capitalizeLabel(labels[0] ?? domain) };
  let tldSize = 1;
  if (labels.length >= 3 && TWO_PART_TLDS.has(labels.slice(-2).join('.'))) tldSize = 2;
  const apexLabels = labels.slice(-(1 + tldSize));
  return { apexDomain: apexLabels.join('.'), companyLabel: capitalizeLabel(apexLabels[0]) };
}

function capitalizeLabel(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function splitName(displayName, email) {
  if (displayName && displayName.trim()) {
    const parts = displayName.trim().split(/\s+/);
    return { firstName: parts[0], lastName: parts.length > 1 ? parts.slice(1).join(' ') : null };
  }
  const local = email.split('@')[0];
  const tokens = local.split(/[._-]+/).filter(Boolean);
  if (!tokens.length) return { firstName: local, lastName: null };
  const first = tokens[0];
  const last = tokens.length > 1 ? tokens.slice(1).join(' ') : null;
  return {
    firstName: first.charAt(0).toUpperCase() + first.slice(1),
    lastName: last ? last.charAt(0).toUpperCase() + last.slice(1) : null,
  };
}

async function writeError(ctx, workspaceId, kind, detail) {
  await ctx.db.query(
    `INSERT INTO integration_state (workspace_id, kind, last_error, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id, kind)
     DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`,
    [workspaceId, kind, detail.slice(0, 500)],
  );
}

