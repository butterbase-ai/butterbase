const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

// ============ AUTOMATED SENDER FILTER ============
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

/**
 * Classify a sender. Returns:
 *   'drop' — machine sender; never create entity
 *   'role' — role mailbox; create entity tagged is_role_account=true
 *   null   — normal person
 */
function classifySender({ email, headers }) {
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
  for (const esp of ESP_DOMAINS) {
    if (domain.endsWith('.' + esp)) return 'drop';
  }
  if (BULK_SUBDOMAIN.test(domain)) return 'drop';

  if (headers) {
    const precedence = (headers['precedence'] || '').toLowerCase();
    if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return 'drop';
    const autoSubmitted = (headers['auto-submitted'] || '').toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') return 'drop';
    if (headers['list-id']) return 'drop';
    if (headers['list-unsubscribe']) return 'drop';
    if (headers['feedback-id']) return 'drop';
    if (headers['x-auto-response-suppress']) return 'drop';
  }

  if (ROLE_LOCAL.test(baseLocal)) return 'role';
  return null;
}

function headerMapFromPayload(payload) {
  const arr = payload?.headers ?? null;
  if (!Array.isArray(arr)) return null;
  const m = {};
  for (const h of arr) {
    const k = String(h?.name ?? h?.key ?? '').toLowerCase();
    if (k) m[k] = String(h?.value ?? '');
  }
  return m;
}
// ============ END FILTER ============

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

  const bind = await ctx.db.query(
    'SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2 AND toolkit_slug = $3 LIMIT 1',
    [workspaceId, userId, 'googlesuper'],
  );
  if (bind.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'not_bound' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  }

  ctx.waitUntil(runIngest(ctx, authHeader, workspaceId, userId).catch(async (e) => {
    const detail = e instanceof Error ? e.message : String(e);
    await writeError(ctx, workspaceId, 'gmail', detail).catch(() => {});
  }));

  return new Response(JSON.stringify({ ok: true, status: 'syncing', workspace_id: workspaceId }), {
    status: 202, headers: { 'content-type': 'application/json' },
  });
}

async function runIngest(ctx, authHeader, workspaceId, userId) {
  const stateRow = await ctx.db.query(
    'SELECT cursor, last_synced_at FROM integration_state WHERE workspace_id = $1 AND kind = $2',
    [workspaceId, 'gmail'],
  );
  const lastSyncedAt = stateRow.rows[0]?.last_synced_at
    ? new Date(stateRow.rows[0].last_synced_at)
    : new Date(Date.now() - 14 * 24 * 3600 * 1000);

  const afterDate = new Date(lastSyncedAt.getTime() - 24 * 3600 * 1000);
  const after = afterDate.toISOString().slice(0, 10).replace(/-/g, '/');
  const query = `after:${after} -category:promotions -category:social`;

  const composioRes = await composioExecute(ctx, authHeader, userId, 'GOOGLESUPER_FETCH_EMAILS', {
    query, max_results: 100, verbose: false, include_payload: true,
  });

  if (!composioRes.successful) {
    const detail = typeof composioRes.error === 'string' ? composioRes.error : JSON.stringify(composioRes.error ?? 'unknown');
    await writeError(ctx, workspaceId, 'gmail', detail);
    return;
  }

  const messages = extractMessages(composioRes.data);
  const myEmail = inferMyEmail(composioRes.data, messages) ?? null;

  const companyCache = new Map();
  const personCache = new Map();
  let droppedAutomated = 0, taggedRole = 0;

  for (const msg of messages) {
    const parsedFrom = parseAddress(msg.sender ?? msg.from);
    const parsedTo = parseAddress(msg.to);
    const ts = msg.messageTimestamp ?? msg.internalDate ?? msg.date;
    const date = ts ? new Date(typeof ts === 'number' || /^\d+$/.test(String(ts)) ? Number(ts) : ts) : new Date();
    const messageId = msg.messageId ?? msg.id ?? null;
    if (!messageId) continue;

    const sent = myEmail && parsedFrom?.email && parsedFrom.email.toLowerCase() === myEmail.toLowerCase();
    const counterparty = sent ? parsedTo : parsedFrom;
    if (!counterparty?.email) continue;

    // Classify sender — drop machine senders, tag role mailboxes.
    // For sent mail, classify the recipient (so we don't create "noreply" contacts when we email them).
    const headerMap = headerMapFromPayload(msg.payload);
    const verdict = classifySender({ email: counterparty.email, headers: sent ? null : headerMap });
    if (verdict === 'drop') { droppedAutomated++; continue; }
    const isRoleAccount = verdict === 'role';
    if (isRoleAccount) taggedRole++;

    let companyId = null;
    const rawDomain = counterparty.email.split('@')[1]?.toLowerCase() ?? null;
    if (rawDomain && !PUBLIC_EMAIL_DOMAINS.has(rawDomain)) {
      const { apexDomain, companyLabel } = deriveCompanyFromDomain(rawDomain);
      if (companyCache.has(apexDomain)) {
        companyId = companyCache.get(apexDomain);
      } else {
        try {
          companyId = await upsertCompanyEntity(ctx, { name: companyLabel, domain: apexDomain });
          if (companyId) companyCache.set(apexDomain, companyId);
        } catch (e) {
          console.warn('substrate upsert company failed', String(e?.message ?? e));
        }
      }
    }

    const { firstName, lastName } = splitName(counterparty.name, counterparty.email);
    let personId = null;
    const emailKey = counterparty.email.toLowerCase();
    if (personCache.has(emailKey)) {
      personId = personCache.get(emailKey);
    } else {
      try {
        personId = await upsertPersonEntity(ctx, {
          first_name: firstName,
          last_name: lastName,
          email: emailKey,
          company_id: companyId,
          is_role_account: isRoleAccount,
        });
        if (personId) personCache.set(emailKey, personId);
      } catch (e) {
        console.warn('substrate upsert person failed', String(e?.message ?? e));
        continue;
      }
    }
    if (!personId) continue;

    try {
      await callFn(ctx, 'crm-record-activity', {
        workspace_id: workspaceId,
        kind: sent ? 'email.sent' : 'email.received',
        entity_type: 'person',
        entity_id: personId,
        dedupe_key: messageId,
        payload: {
          message_id: messageId,
          thread_id: msg.threadId ?? null,
          subject: msg.subject ?? null,
          snippet: ((msg.preview && msg.preview.body) ? msg.preview.body : (msg.snippet ?? '')).slice(0, 240) || null,
          from: parsedFrom?.email ?? null,
          to: parsedTo?.email ?? null,
          company_id: companyId,
        },
        occurred_at: date.toISOString(),
      });
    } catch (e) {
      console.warn('crm-record-activity failed', String(e?.message ?? e));
    }
  }

  console.log('[ingest-gmail] done',
    'messages=', messages.length,
    'droppedAutomated=', droppedAutomated,
    'taggedRole=', taggedRole);

  await ctx.db.query(
    `INSERT INTO integration_state (workspace_id, kind, cursor, last_synced_at, last_error, updated_at)
     VALUES ($1, $2, $3, now(), NULL, now())
     ON CONFLICT (workspace_id, kind)
     DO UPDATE SET cursor = EXCLUDED.cursor, last_synced_at = now(), last_error = NULL, updated_at = now()`,
    [workspaceId, 'gmail', extractNextPageToken(composioRes.data)],
  );
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
  if (!res.ok) {
    throw new Error(`${fnName} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

async function composioExecute(ctx, authHeader, userId, toolName, params) {
  const url = `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/integrations/execute`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body: JSON.stringify({ toolName, params, userId }),
  });
  if (!res.ok) throw new Error(`composio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

function extractMessages(data) {
  if (!data) return [];
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.data?.messages)) return data.data.messages;
  if (Array.isArray(data)) return data;
  return [];
}

function extractNextPageToken(data) {
  if (!data) return null;
  return data.nextPageToken ?? data.data?.nextPageToken ?? null;
}

function inferMyEmail(data, messages) {
  if (typeof data?.user_id === 'string' && data.user_id.includes('@')) return data.user_id.toLowerCase();
  if (typeof data?.emailAddress === 'string') return data.emailAddress.toLowerCase();
  const counts = {};
  for (const m of messages) {
    for (const raw of [m.sender ?? m.from, m.to]) {
      const a = parseAddress(raw)?.email;
      if (a) counts[a.toLowerCase()] = (counts[a.toLowerCase()] ?? 0) + 1;
    }
  }
  let best = null, bestCount = 0;
  for (const [email, n] of Object.entries(counts)) {
    if (n > bestCount) { best = email; bestCount = n; }
  }
  return best;
}

function parseAddress(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') {
    if (typeof raw.email === 'string') return { name: raw.name ?? null, email: raw.email };
    return null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || null), email: m[2] };
  if (s.includes('@')) return { name: null, email: s };
  return null;
}

const TWO_PART_TLDS = new Set([
  'co.uk','co.jp','co.kr','co.in','co.nz','co.za','co.id','co.il',
  'com.au','com.br','com.cn','com.hk','com.mx','com.ng','com.sg','com.tr','com.tw',
  'org.uk','net.au','ac.uk','gov.uk',
]);

function deriveCompanyFromDomain(rawDomain) {
  const domain = rawDomain.toLowerCase().replace(/^\.+|\.+$/g, '');
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 1) {
    return { apexDomain: domain, companyLabel: capitalizeLabel(labels[0] ?? domain) };
  }
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

