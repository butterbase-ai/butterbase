function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

const READ_ACTIONS = new Set([
  "findEntities", "getEntity",
  "searchMemory",
  "listSourceArtifactsHttp", "getSourceArtifactHttp",
]);

const HARD_LIMIT = 50;

function sanitizeQ(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw;
  s = s.replace(/([\w.+-]+)@[\w.-]+/g, ' $1 ');
  s = s.replace(/#/g, ' ');
  s = s.replace(/[,.;:!?()'"\/\\]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function httpSubstrate(ctx, path) {
  const candidates = [ctx.env.SUBSTRATE_TOKEN, ctx.env.BUTTERBASE_API_KEY].filter(Boolean);
  let lastErr = null;
  for (const tok of candidates) {
    const url = `${ctx.env.BUTTERBASE_API_URL}${path}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.ok) return { ok: true, data: await r.json() };
    if (r.status !== 401 && r.status !== 403 && r.status !== 404) {
      const txt = await r.text().catch(() => '');
      return { ok: false, status: r.status, body: txt.slice(0, 500) };
    }
    if (r.status === 404) return { ok: true, data: { source_artifacts: [] }, empty: true };
    lastErr = { status: r.status, body: (await r.text().catch(() => '')).slice(0, 200) };
  }
  return { ok: false, ...lastErr };
}

function unwrapArtifacts(httpData) {
  if (!httpData) return [];
  if (Array.isArray(httpData)) return httpData;
  if (Array.isArray(httpData.source_artifacts)) return httpData.source_artifacts;
  if (Array.isArray(httpData.data)) return httpData.data;
  return [];
}

export default async function handler(req, ctx) {
  const t = ctx.caller?.type;
  if (t !== 'loopback' && t !== 'service_key') {
    return json({ error: 'forbidden', caller_type: t || null }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  const { action, params } = body || {};
  if (!action) return json({ error: 'missing_action' }, 400);
  if (!READ_ACTIONS.has(action)) {
    return json({ error: 'action_not_allowed', allowed: Array.from(READ_ACTIONS) }, 403);
  }

  const safeParams = { ...(params || {}) };
  if (typeof safeParams.limit === 'number') {
    safeParams.limit = Math.min(safeParams.limit, HARD_LIMIT);
  } else {
    safeParams.limit = HARD_LIMIT;
  }

  const sourceArtifactRequested =
    Array.isArray(safeParams.kinds) && safeParams.kinds.length === 1 && safeParams.kinds[0] === 'source_artifacts';

  try {
    let result;
    switch (action) {
      case 'findEntities': {
        const rawQ = safeParams.q;
        if (typeof rawQ === 'string' && rawQ) {
          const cleaned = sanitizeQ(rawQ);
          if (cleaned) safeParams.q = cleaned;
          else delete safeParams.q;
        }
        try {
          result = await ctx.substrate.findEntities(safeParams);
          return json({ ok: true, data: result, sanitized_q: safeParams.q !== rawQ ? (safeParams.q ?? null) : undefined });
        } catch (err) {
          if (String(err?.message || '').includes('404')) return json({ ok: true, data: [], note: 'substrate 404 → empty' });
          throw err;
        }
      }

      case 'getEntity':
        try {
          result = await ctx.substrate.getEntity(safeParams.entity_id || safeParams.id);
          return json({ ok: true, data: result });
        } catch (err) {
          if (String(err?.message || '').includes('404')) return json({ ok: true, data: null, note: 'substrate 404 → not found' });
          throw err;
        }

      case 'searchMemory': {
        const rawQ = safeParams.query || safeParams.q;
        const q = sanitizeQ(rawQ);
        const opts = { kinds: safeParams.kinds, limit: safeParams.limit, match: safeParams.match };
        try {
          result = await ctx.substrate.searchMemory(q, opts);
          return json({ ok: true, data: result, sanitized_q: q !== rawQ ? q : undefined });
        } catch (err) {
          const msg = String(err?.message || '');
          if (!msg.includes('404')) throw err;
          if (sourceArtifactRequested) {
            const qs = new URLSearchParams();
            qs.set('limit', String(safeParams.limit));
            if (q) qs.set('q', q);
            const http = await httpSubstrate(ctx, `/v1/me/substrate/source-artifacts?${qs.toString()}`);
            if (http.ok) {
              const artifacts = unwrapArtifacts(http.data);
              return json({ ok: true, data: artifacts, count: artifacts.length, sanitized_q: q !== rawQ ? q : undefined, routed_via: 'http:/v1/me/substrate/source-artifacts', empty: artifacts.length === 0 });
            }
            return json({
              ok: true, data: [],
              note: `source-artifact HTTP fallback unauthorized (status=${http.status}).`,
              fallback_status: http.status,
            });
          }
          return json({ ok: true, data: [], sanitized_q: q !== rawQ ? q : undefined, note: 'substrate.searchMemory returned 404 — interpreting as no results' });
        }
      }

      case 'listSourceArtifactsHttp': {
        const qs = new URLSearchParams();
        qs.set('limit', String(safeParams.limit));
        const q = sanitizeQ(safeParams.q);
        if (q) qs.set('q', q);
        if (safeParams.kind) qs.set('kind', safeParams.kind);
        const http = await httpSubstrate(ctx, `/v1/me/substrate/source-artifacts?${qs.toString()}`);
        if (http.ok) {
          const artifacts = unwrapArtifacts(http.data);
          return json({ ok: true, data: artifacts, count: artifacts.length, routed_via: 'http:/v1/me/substrate/source-artifacts', empty: artifacts.length === 0 });
        }
        return json({ ok: true, data: [], note: `unauthorized (status=${http.status})`, fallback_status: http.status });
      }

      case 'getSourceArtifactHttp': {
        const id = safeParams.artifact_id || safeParams.id;
        if (!id) return json({ error: 'missing artifact_id' }, 400);
        const http = await httpSubstrate(ctx, `/v1/me/substrate/source-artifacts/${encodeURIComponent(id)}`);
        if (http.ok) return json({ ok: true, data: http.data, routed_via: `http:/v1/me/substrate/source-artifacts/${id}` });
        return json({ ok: true, data: null, note: `unauthorized (status=${http.status})`, fallback_status: http.status });
      }
    }
  } catch (err) {
    console.error('substrate-read-internal: substrate call failed', action, err?.message);
    return json({ error: 'substrate_call_failed', action, message: err?.message }, 502);
  }
}
