// crm-record-activity — single write path for activity rows.
// Dedupe by a caller-supplied dedupe_key carried in payload->>'dedupe_key'.

interface Body {
  workspace_id: string;
  kind: string;
  entity_type: 'person' | 'company';
  entity_id: string;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
  occurred_at?: string | null;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export async function handler(req: Request, ctx: any) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let body: Body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }

  if (!body?.workspace_id || !body?.kind || !body?.entity_type || !body?.entity_id) {
    return json(400, { error: 'workspace_id, kind, entity_type, entity_id required' });
  }

  const mem = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [body.workspace_id, ctx.user.id],
  );
  if (mem.rows.length === 0) return json(403, { error: 'not_a_member' });

  if (body.dedupe_key) {
    const dup = await ctx.db.query(
      `SELECT id FROM activities
        WHERE workspace_id = $1 AND kind = $2 AND payload->>'dedupe_key' = $3
        LIMIT 1`,
      [body.workspace_id, body.kind, body.dedupe_key],
    );
    if (dup.rows.length) return json(200, { id: dup.rows[0].id, created: false });
  }

  const payload = { ...(body.payload ?? {}), ...(body.dedupe_key ? { dedupe_key: body.dedupe_key } : {}) };
  const occurredAt = body.occurred_at ? new Date(body.occurred_at).toISOString() : new Date().toISOString();

  const ins = await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id`,
    [body.workspace_id, ctx.user.id, body.kind, body.entity_type, body.entity_id,
     JSON.stringify(payload), occurredAt],
  );

  return json(200, { id: ins.rows[0].id, created: true });
}


