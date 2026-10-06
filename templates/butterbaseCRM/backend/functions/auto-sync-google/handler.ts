/**
 * auto-sync-google — cron, every 5 minutes.
 */

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function invokeAsUser(ctx, fnName, workspaceId, userId) {
  const started = performance.now();
  try {
    const res = await ctx.invoke(
      fnName,
      { workspace_id: workspaceId },
      { headers: { 'x-butterbase-as-user': userId } },
    );
    const text = await res.text();
    const elapsed = Math.round(performance.now() - started);
    console.log(`[invoke] ${fnName} ${res.status} ${elapsed}ms ws=${workspaceId.slice(0, 8)}`);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    if (!res.ok) return { error: `${fnName} ${res.status}`, body: parsed };
    return parsed;
  } catch (e) {
    const elapsed = Math.round(performance.now() - started);
    const msg = String(e?.message ?? e);
    console.error(`[invoke] ${fnName} FAILED ${elapsed}ms: ${msg}`);
    return { error: msg.slice(0, 300) };
  }
}

// Single-flight lock for the cron itself. If a prior tick is still running
// (e.g. backlog catch-up taking longer than the 5-min schedule), subsequent
// ticks short-circuit instead of piling up. The TTL is the deadman switch in
// case the holding tick crashes without releasing.
const LOCK_KEY = 'lock:auto-sync-google';
const LOCK_TTL_SECONDS = 900; // 15 min, matches function timeoutMs

export async function handler(_req, ctx) {
  const tickStart = performance.now();
  console.log('[auto-sync-google] tick start');

  const runId = crypto.randomUUID();
  const acquired = await ctx.kv.setnx(LOCK_KEY, runId, { ttl: LOCK_TTL_SECONDS });
  if (!acquired) {
    const holder = await ctx.kv.get(LOCK_KEY).catch(() => null);
    console.log(`[auto-sync-google] another tick holds lock (holder=${holder}); skipping`);
    return json(200, { skipped: 'lock_held', holder });
  }

  try {
    return await runTick(ctx, tickStart, runId);
  } finally {
    try {
      const current = await ctx.kv.get(LOCK_KEY);
      if (current === runId) await ctx.kv.del(LOCK_KEY);
    } catch { /* swallow */ }
  }
}

async function runTick(ctx, tickStart, runId) {
  const qStart = performance.now();
  const targets = await ctx.db.query(
    `SELECT wi.workspace_id, wi.user_id
       FROM workspace_integrations wi
       JOIN sync_settings s ON s.workspace_id = wi.workspace_id
      WHERE wi.toolkit_slug = 'googlesuper'
        AND s.google_autosync_enabled = true`,
  );

  const fallback = await ctx.db.query(
    `SELECT wi.workspace_id, wi.user_id
       FROM workspace_integrations wi
      WHERE wi.toolkit_slug = 'googlesuper'
        AND wi.workspace_id NOT IN (SELECT workspace_id FROM sync_settings)`,
  );
  console.log(`[auto-sync-google] target query ${Math.round(performance.now() - qStart)}ms`);

  const allTargets = [...targets.rows, ...fallback.rows];
  console.log(`[auto-sync-google] targets=${allTargets.length}`);
  if (allTargets.length === 0) return json(200, { targets: 0, results: [] });

  const results = [];
  for (let i = 0; i < allTargets.length; i++) {
    const t = allTargets[i];
    const wsTag = `[${i + 1}/${allTargets.length} ws=${t.workspace_id.slice(0, 8)}]`;
    const iterStart = performance.now();
    console.log(`${wsTag} start`);
    const r = { workspace_id: t.workspace_id, user_id: t.user_id, gmail: null, calendar: null, enrichment: null };
    r.gmail = await invokeAsUser(ctx, 'ingest-gmail', t.workspace_id, t.user_id);
    r.calendar = await invokeAsUser(ctx, 'ingest-calendar', t.workspace_id, t.user_id);
    r.enrichment = await invokeAsUser(ctx, 'trigger-enrichment', t.workspace_id, t.user_id);
    console.log(`${wsTag} done ${Math.round(performance.now() - iterStart)}ms`);
    results.push(r);
  }

  console.log(`[auto-sync-google] tick done targets=${allTargets.length} ${Math.round(performance.now() - tickStart)}ms run=${runId.slice(0, 8)}`);
  return json(200, { targets: allTargets.length, results });
}

