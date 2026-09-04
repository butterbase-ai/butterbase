// Single-tenant substrate proxy. All ops act as the linked substrate owner via
// ctx.substrate. The browser sends { op, ...args } and gets back JSON. No bb_sub_
// key in the browser.
//
// Supported ops (read):
//   list_entities { type, q?, limit? }
//   get_entity   { id }
//   list_actions { capability?, status?, before?, limit? }
//
// Supported ops (write):
//   propose       { capability, payload, idempotency_key? }
//   revert_action { action_id }
//
// Constraints baked in (from 2026-06-10 probe):
//  - /entities ignores order_by/offset/cursor/attrs.*/updated_after — caller filters client-side.
//  - /actions ignores entity_id/from/to — caller pages with `before` and filters client-side.
//  - update_entity replaces attrs wholesale — propose payload must pass full merged attrs.

const ENTITY_TYPES = ['person', 'company', 'fund', 'workspace', 'team', 'project', 'event', 'agent', 'self'] as const;
type EntityType = typeof ENTITY_TYPES[number];

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clampLimit(v: unknown, max = 200): number {
  const n = Number(v) || 50;
  return Math.min(Math.max(n, 1), max);
}

export async function handler(req, ctx) {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });
  if (!ctx.substrate) return jsonResponse(503, { error: 'substrate_not_linked' });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const op = String(body?.op ?? '');
  if (!op) return jsonResponse(400, { error: 'missing op' });

  try {
    switch (op) {
      case 'list_entities': {
        const type = body.type as EntityType | undefined;
        if (type && !ENTITY_TYPES.includes(type)) {
          return jsonResponse(400, { error: `unknown entity type: ${type}` });
        }
        const limit = clampLimit(body.limit, 200);
        const q = typeof body.q === 'string' && body.q.length > 0 ? body.q : undefined;
        const entities = await ctx.substrate.findEntities({ type, q, limit });
        return jsonResponse(200, { entities });
      }

      case 'get_entity': {
        const id = String(body.id ?? '');
        if (!id) return jsonResponse(400, { error: 'missing id' });
        const entity = await ctx.substrate.getEntity(id);
        if (!entity) return jsonResponse(404, { error: 'not_found' });
        return jsonResponse(200, { entity });
      }

      case 'list_actions': {
        const params = new URLSearchParams();
        params.set('limit', String(clampLimit(body.limit, 200)));
        if (body.capability) params.set('capability', String(body.capability));
        if (body.status) params.set('status', String(body.status));
        if (body.before) params.set('before', String(body.before));
        const res = await ctx.substrate.http?.get?.(`/actions?${params}`)
          ?? await rawGet(ctx, `/actions?${params}`);
        return jsonResponse(200, res);
      }

      case 'propose': {
        const capability = String(body.capability ?? '');
        if (!capability) return jsonResponse(400, { error: 'missing capability' });
        const payload = body.payload ?? {};
        const idempotency_key = body.idempotency_key;
        const verdict = await ctx.substrate.propose(capability, payload, { idempotency_key });
        return jsonResponse(200, verdict);
      }

      case 'revert_action': {
        const action_id = String(body.action_id ?? '');
        if (!action_id) return jsonResponse(400, { error: 'missing action_id' });
        const verdict = await ctx.substrate.propose('revert_action', { action_id });
        return jsonResponse(200, verdict);
      }

      default:
        return jsonResponse(400, { error: `unknown op: ${op}` });
    }
  } catch (e: any) {
    return jsonResponse(502, { error: 'substrate_op_failed', op, detail: String(e?.message ?? e) });
  }
}

// Fallback raw GET for routes the ctx.substrate SDK doesn't expose helpers for
// (e.g. /actions). Uses the substrate token wired into the platform runtime.
async function rawGet(ctx: any, path: string) {
  const baseUrl = ctx.substrate.baseUrl ?? 'https://api.butterbase.ai/v1/me/substrate';
  const token = ctx.substrate.token ?? ctx.substrate.apiKey;
  if (!token) throw new Error('substrate token unavailable in ctx');
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`substrate ${path} returned ${res.status}`);
  return await res.json();
}

