const TEMPLATE_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;
const EMAIL_RE = /.+@.+\..+/;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function renderTemplate(tpl, vars) {
  return tpl.replace(TEMPLATE_RE, (_, k) => {
    const v = vars[k.toLowerCase()];
    return v == null ? '' : String(v);
  });
}

// Substrate is the source of truth for person email; the campaign_list_members
// snapshot is a stale fallback for cases where substrate is unreachable.
async function liveEmailFromSubstrate(ctx, entityId, entityType) {
  if (!ctx.substrate || entityType !== 'people' || !entityId) return null;
  try {
    const ent = await ctx.substrate.getEntity(entityId);
    const e = ent?.attrs?.email;
    if (typeof e === 'string' && EMAIL_RE.test(e)) return e;
  } catch { /* fall back */ }
  return null;
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const campaignId = body?.campaign_id;
  if (!campaignId || typeof campaignId !== 'string') return json(400, { error: 'campaign_id required' });

  const c = await ctx.db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId]);
  if (c.rows.length === 0) return json(404, { error: 'not_found' });
  const campaign = c.rows[0];

  if (campaign.status !== 'draft') return json(409, { error: 'not_draft', current_status: campaign.status });

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [campaign.workspace_id, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });

  const bind = await ctx.db.query(
    'SELECT 1 FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2 AND toolkit_slug = $3 LIMIT 1',
    [campaign.workspace_id, campaign.from_user_id, 'googlesuper'],
  );
  if (bind.rows.length === 0) {
    return json(409, { error: 'sender_not_connected', detail: 'The campaign sender has not connected Google to this workspace.' });
  }

  const members = await ctx.db.query(
    `SELECT entity_id, entity_type, email_snapshot AS email, vars_snapshot
       FROM campaign_list_members
      WHERE list_id = $1`,
    [campaign.list_id],
  );

  // Resolve each member to a live email: prefer substrate, fall back to snapshot.
  // For lists of typical size (10-100) this is fine; if lists grow much larger
  // we should batch via findEntities.
  const resolved = [];
  for (const r of members.rows) {
    const live = await liveEmailFromSubstrate(ctx, r.entity_id, r.entity_type);
    const email = live ?? (typeof r.email === 'string' && EMAIL_RE.test(r.email) ? r.email : null);
    if (email) resolved.push({ ...r, email });
  }

  if (resolved.length === 0) {
    return json(422, { error: 'no_addressable_members', detail: 'List has no members with a valid email (substrate + snapshot both empty).' });
  }

  const dailyLimit = Math.max(1, Math.min(30, campaign.daily_limit ?? 25));
  const throttle = Math.max(60, Math.min(3600, campaign.throttle_seconds ?? 180));
  const startMs = Date.now();

  const values = [];
  const params = [];
  let p = 1;
  for (let i = 0; i < resolved.length; i++) {
    const row = resolved[i];
    const day = Math.floor(i / dailyLimit);
    const slot = i % dailyLimit;
    const scheduledMs = startMs + day * 24 * 60 * 60 * 1000 + slot * throttle * 1000;
    const scheduledFor = new Date(scheduledMs).toISOString();
    const snap = row.vars_snapshot ?? {};
    const firstName = snap.first_name ?? '';
    const lastName = snap.last_name ?? '';
    const vars = {
      first_name: firstName,
      last_name: lastName,
      full_name: [firstName, lastName].filter(Boolean).join(' '),
      email: row.email,
      title: snap.title ?? '',
      company: snap.company_name ?? '',
    };
    const subject = renderTemplate(campaign.subject, vars);
    const bodyText = renderTemplate(campaign.body_template, vars);

    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(campaign.workspace_id, campaign.id, row.entity_type, row.entity_id, row.email, subject, bodyText, scheduledFor);
  }

  await ctx.db.query(
    `INSERT INTO campaign_sends
       (workspace_id, campaign_id, entity_type, entity_id, email, resolved_subject, resolved_body, scheduled_for)
       VALUES ${values.join(', ')}`,
    params,
  );

  await ctx.db.query(
    `UPDATE campaigns
        SET status = 'active', started_at = now(), total_count = $2, updated_at = now()
      WHERE id = $1`,
    [campaign.id, resolved.length],
  );

  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, 'campaign.started', 'campaign', $3, $4::jsonb)`,
    [campaign.workspace_id, ctx.user.id, campaign.id, JSON.stringify({ name: campaign.name, total: resolved.length, daily_limit: dailyLimit, throttle_seconds: throttle })],
  ).catch(() => {});

  return json(200, { status: 'active', queued: resolved.length, daily_limit: dailyLimit, throttle_seconds: throttle });
}

