const THRESHOLD = 3;
const WINDOW_HOURS = 24;
const LOW_SCORE_CUTOFF = 0.5;

function isLowQualityDiagnosis(d) {
  if (d.confidence === 'low') return true;
  const items = Array.isArray(d.evidence) ? d.evidence
    : (Array.isArray(d.evidence?.items) ? d.evidence.items : []);
  if (items.length === 0) return true;
  const scored = items.filter((it) => typeof it?.score === 'number');
  if (scored.length > 0 && scored.every((it) => it.score < LOW_SCORE_CUTOFF)) return true;
  return false;
}

async function upsertSignal(ctx, signalKind, signalKey, ticketIds, earliest, latest) {
  const unique = Array.from(new Set(ticketIds));
  const count = unique.length;
  const up = await ctx.db.query(
    `INSERT INTO pattern_signals
       (signal_kind, signal_key, count, first_seen_at, last_seen_at, sample_ticket_ids, surfaced)
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], false)
     ON CONFLICT (signal_kind, signal_key) DO UPDATE
       SET count = EXCLUDED.count,
           last_seen_at = GREATEST(pattern_signals.last_seen_at, EXCLUDED.last_seen_at),
           sample_ticket_ids = EXCLUDED.sample_ticket_ids
     RETURNING id, surfaced, count`,
    [signalKind, signalKey, count, earliest, latest, unique.slice(0, 10)],
  );
  return { row: up.rows[0], unique, count };
}

async function maybeSurface(ctx, row, signalKind, signalKey, count, unique) {
  if (count < THRESHOLD || row.surfaced) return false;

  const sampleIds = unique.slice(0, 5).join(', ');
  const title = signalKind === 'recurring_topic'
    ? `Recurring customer topic: ${signalKey}`
    : `Docs gap surfaced: ${signalKey}`;
  const description = signalKind === 'recurring_topic'
    ? `${count} customers asked about "${signalKey}" in the last ${WINDOW_HOURS}h. Sample tickets: ${sampleIds}. (signal_kind=recurring_topic, signal_key=${signalKey})`
    : `${count} customer questions in the last ${WINDOW_HOURS}h hit a docs gap on topic "${signalKey}". Consider adding docs. Sample tickets: ${sampleIds}. (signal_kind=docs_gap, signal_key=${signalKey})`;

  try {
    await ctx.substrate.propose('record_learning', {
      title,
      description,
    }, { idempotency_key: `pattern:${row.id}:${count}` });
  } catch (err) {
    console.warn('sweep-pattern-signals: substrate propose failed, leaving surfaced=false for retry', err?.message);
    return false;
  }

  await ctx.db.query(
    'UPDATE pattern_signals SET surfaced = true, surfaced_at = now() WHERE id = $1',
    [row.id],
  );
  return true;
}

export default async function handler(req, ctx) {
  // Trigger.auth='none'; gate inside on ctx.caller.type.
  // Allowed: cron (scheduled fire), loopback (ctx.invoke), service_key (admin/MCP).
  const t = ctx.caller?.type;
  if (t !== 'cron' && t !== 'loopback' && t !== 'service_key') {
    return new Response(JSON.stringify({ error: 'forbidden', caller_type: t || null }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  const ticketsR = await ctx.db.query(
    `SELECT topic_tag,
            COUNT(*)::int AS count,
            MIN(opened_at) AS earliest,
            MAX(opened_at) AS latest,
            ARRAY_AGG(id ORDER BY opened_at) AS ticket_ids
       FROM support_tickets
      WHERE topic_tag IS NOT NULL
        AND opened_at > now() - interval '${WINDOW_HOURS} hours'
      GROUP BY topic_tag
     HAVING COUNT(*) >= 2`,
  );

  const diagR = await ctx.db.query(
    `SELECT d.id, d.ticket_id, d.evidence, d.confidence, d.produced_at, t.topic_tag
       FROM diagnoses d
       JOIN support_tickets t ON t.id = d.ticket_id
      WHERE d.produced_at > now() - interval '${WINDOW_HOURS} hours'
        AND d.superseded_at IS NULL
        AND t.topic_tag IS NOT NULL`,
  );
  const gapGroups = new Map();
  for (const d of diagR.rows) {
    if (!isLowQualityDiagnosis(d)) continue;
    if (!gapGroups.has(d.topic_tag)) {
      gapGroups.set(d.topic_tag, { ticket_ids: [], earliest: d.produced_at, latest: d.produced_at });
    }
    const g = gapGroups.get(d.topic_tag);
    g.ticket_ids.push(d.ticket_id);
    if (d.produced_at < g.earliest) g.earliest = d.produced_at;
    if (d.produced_at > g.latest) g.latest = d.produced_at;
  }
  for (const [k, v] of Array.from(gapGroups.entries())) {
    if (new Set(v.ticket_ids).size < 2) gapGroups.delete(k);
  }

  let topicSurfaced = 0, gapSurfaced = 0;

  for (const t of ticketsR.rows) {
    const { row, unique, count } = await upsertSignal(
      ctx, 'recurring_topic', t.topic_tag, t.ticket_ids, t.earliest, t.latest,
    );
    if (await maybeSurface(ctx, row, 'recurring_topic', t.topic_tag, count, unique)) topicSurfaced += 1;
  }
  for (const [tag, g] of gapGroups.entries()) {
    const { row, unique, count } = await upsertSignal(
      ctx, 'docs_gap', tag, g.ticket_ids, g.earliest, g.latest,
    );
    if (await maybeSurface(ctx, row, 'docs_gap', tag, count, unique)) gapSurfaced += 1;
  }

  const out = {
    ok: true,
    recurring_topic: { groups: ticketsR.rows.length, newly_surfaced: topicSurfaced },
    docs_gap: { groups: gapGroups.size, newly_surfaced: gapSurfaced },
  };
  console.info('sweep-pattern-signals:', JSON.stringify(out));
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
}
