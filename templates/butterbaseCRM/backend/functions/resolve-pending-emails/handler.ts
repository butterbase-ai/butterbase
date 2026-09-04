const MAX_PERSONS_SCANNED = 500;
const MAX_RESOLVES_PER_RUN = 100;
const STALE_HOURS = 2;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function pollLookup(ctx, lookupId) {
  try {
    const res = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/people/email-lookup/${encodeURIComponent(lookupId)}`,
      {
        headers: { authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const text = await res.text();
    console.log(`[poll] id=${lookupId} http=${res.status} body=${text.slice(0, 300)}`);
    if (!res.ok) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    console.log(`[poll] id=${lookupId} fetch_error=${e?.message}`);
    return null;
  }
}

async function queueEmailLookup(ctx, linkedinUrl) {
  try {
    const res = await fetch(
      `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/people/profile/email`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
        body: JSON.stringify({ linkedinProfileUrl: linkedinUrl }),
      },
    );
    if (!res.ok) {
      const detail = await res.text();
      return { lookupId: null, error: `${res.status}:${detail.slice(0, 100)}` };
    }
    const j = await res.json();
    return { lookupId: j?.lookupId ?? null };
  } catch (e) {
    return { lookupId: null, error: String(e?.message ?? e).slice(0, 100) };
  }
}

export async function handler(_req, ctx) {
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });

  const persons = await ctx.substrate.findEntities({ type: 'person', limit: MAX_PERSONS_SCANNED });
  const personList = Array.isArray(persons) ? persons : [];
  const pending = personList.filter(
    (p) => p?.attrs?.email_status === 'pending' && typeof p?.attrs?.email_lookup_id === 'string',
  );
  const failedQueue = personList.filter(
    (p) =>
      p?.attrs?.email_status === 'unknown' &&
      typeof p?.attrs?.email_lookup_error === 'string' &&
      typeof p?.attrs?.linkedin_url === 'string',
  );
  const verifiedWithEmail = personList.filter(
    (p) => p?.attrs?.email_status === 'verified' && typeof p?.attrs?.email === 'string',
  );

  let resolved = 0;
  let failed = 0;
  let stillPending = 0;
  let expiredGiveUp = 0;
  let requeued = 0;
  let requeueFailed = 0;
  let snapshotsBackfilled = 0;
  const now = Date.now();

  for (const person of verifiedWithEmail) {
    try {
      const upd = await ctx.db.query(
        `UPDATE campaign_list_members
         SET email_snapshot = $1
         WHERE entity_id = $2 AND email_snapshot IS NULL`,
        [person.attrs.email, person.entity_id ?? person.id],
      );
      snapshotsBackfilled += upd.rowCount ?? 0;
    } catch { /* non-fatal */ }
  }

  for (const person of failedQueue.slice(0, MAX_RESOLVES_PER_RUN)) {
    const queued = await queueEmailLookup(ctx, person.attrs.linkedin_url);
    if (queued.lookupId) {
      await ctx.substrate.propose('patch_entity', {
        id: person.entity_id ?? person.id,
        attrs_patch: {
          email_status: 'pending',
          email_lookup_id: queued.lookupId,
          email_lookup_queued_at: new Date().toISOString(),
          email_lookup_error: null,
        },
      });
      requeued += 1;
    } else {
      if (queued.error && queued.error !== person.attrs.email_lookup_error) {
        await ctx.substrate.propose('patch_entity', {
          id: person.entity_id ?? person.id,
          attrs_patch: { email_lookup_error: queued.error },
        });
      }
      requeueFailed += 1;
    }
  }

  // Fan out all polls concurrently — each capped at 10s so no single
  // hanging request can stall the batch or blow the function timeout.
  const batch = pending.slice(0, MAX_RESOLVES_PER_RUN);
  const pollResults = await Promise.allSettled(
    batch.map((person) =>
      pollLookup(ctx, person.attrs.email_lookup_id).then((poll) => ({ person, poll })),
    ),
  );

  for (const result of pollResults) {
    if (result.status === 'rejected') continue;
    const { person, poll } = result.value;
    const queuedAt = person.attrs.email_lookup_queued_at;
    const ageHours = queuedAt ? (now - Date.parse(queuedAt)) / 3_600_000 : 0;

    if (poll?.status === 'resolved' && poll.email) {
      const personEntityId = person.entity_id ?? person.id;
      await ctx.substrate.propose('patch_entity', {
        id: personEntityId,
        attrs_patch: {
          email: poll.email,
          email_status: 'verified',
          email_resolved_at: new Date().toISOString(),
          email_lookup_id: null,
        },
      });
      try {
        await ctx.db.query(
          `UPDATE campaign_list_members
           SET email_snapshot = $1
           WHERE entity_id = $2 AND email_snapshot IS NULL`,
          [poll.email, personEntityId],
        );
      } catch { /* non-fatal */ }
      resolved += 1;
    } else if (poll?.status === 'failed' || poll?.status === 'expired') {
      await ctx.substrate.propose('patch_entity', {
        id: person.entity_id ?? person.id,
        attrs_patch: {
          email_status: 'failed',
          email_lookup_id: null,
          email_lookup_error: poll.status,
        },
      });
      failed += 1;
    } else if (ageHours > STALE_HOURS) {
      await ctx.substrate.propose('patch_entity', {
        id: person.entity_id ?? person.id,
        attrs_patch: {
          email_status: 'failed',
          email_lookup_id: null,
          email_lookup_error: `stale_after_${STALE_HOURS}h`,
        },
      });
      expiredGiveUp += 1;
    } else {
      stillPending += 1;
    }
  }

  return json(200, {
    scanned: personList.length,
    pending_total: pending.length,
    processed_this_run: batch.length,
    resolved,
    failed,
    expired_give_up: expiredGiveUp,
    still_pending: stillPending,
    failed_queue_total: failedQueue.length,
    requeued,
    requeue_failed: requeueFailed,
    snapshots_backfilled: snapshotsBackfilled,
  });
}

