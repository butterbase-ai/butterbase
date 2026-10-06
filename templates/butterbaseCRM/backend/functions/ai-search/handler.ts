function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SCHEMA = {
  companies: { columns: { name: 'text', domain: 'text', industry: 'text', location: 'text', employee_count: 'integer', description: 'text', created_at: 'timestamptz', updated_at: 'timestamptz' }, select: '*' },
  people:    { columns: { first_name: 'text', last_name: 'text', email: 'text', title: 'text', phone: 'text', created_at: 'timestamptz', updated_at: 'timestamptz' }, select: '*' },
  deals:     { columns: { name: 'text', stage: 'text', amount_cents: 'integer', currency: 'text', close_date: 'date', created_at: 'timestamptz', updated_at: 'timestamptz' }, select: '*' },
};

const ALLOWED_OPS = new Set(['eq','neq','gt','gte','lt','lte','ilike','is_null','not_null','in','between']);

function opToSql(op, col, ph, ph2) {
  switch (op) {
    case 'eq': return `${col} = ${ph}`;
    case 'neq': return `${col} <> ${ph}`;
    case 'gt': return `${col} > ${ph}`;
    case 'gte': return `${col} >= ${ph}`;
    case 'lt': return `${col} < ${ph}`;
    case 'lte': return `${col} <= ${ph}`;
    case 'ilike': return `${col} ILIKE ${ph}`;
    case 'is_null': return `${col} IS NULL`;
    case 'not_null': return `${col} IS NOT NULL`;
    case 'in': return `${col} = ANY(${ph}::text[])`;
    case 'between': return `${col} BETWEEN ${ph} AND ${ph2}`;
  }
  return null;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'not_an_object' };
  const t = spec.table;
  if (!SCHEMA[t]) return { ok: false, error: `bad_table:${t}` };
  const tableDef = SCHEMA[t];
  const filters = Array.isArray(spec.filters) ? spec.filters : [];
  if (filters.length > 8) return { ok: false, error: 'too_many_filters' };
  for (const f of filters) {
    if (!f || typeof f !== 'object') return { ok: false, error: 'filter_shape' };
    if (!(f.column in tableDef.columns)) return { ok: false, error: `bad_column:${f.column}` };
    if (!ALLOWED_OPS.has(f.op)) return { ok: false, error: `bad_op:${f.op}` };
    if (f.op === 'between') {
      if (!Array.isArray(f.value) || f.value.length !== 2) return { ok: false, error: 'between_needs_pair' };
    } else if (f.op === 'in') {
      if (!Array.isArray(f.value) || f.value.length === 0) return { ok: false, error: 'in_needs_array' };
    } else if (f.op !== 'is_null' && f.op !== 'not_null') {
      if (f.value === undefined) return { ok: false, error: 'missing_value' };
    }
  }
  if (spec.order_by) {
    if (!(spec.order_by.column in tableDef.columns)) return { ok: false, error: `bad_order_column:${spec.order_by.column}` };
    if (spec.order_by.direction && !['asc', 'desc'].includes(spec.order_by.direction)) return { ok: false, error: 'bad_direction' };
  }
  return { ok: true };
}

function buildSql(spec, workspace_id) {
  const tableDef = SCHEMA[spec.table];
  const params = [workspace_id];
  const where = [`workspace_id = $1`];
  for (const f of (spec.filters ?? [])) {
    if (f.op === 'is_null' || f.op === 'not_null') { where.push(opToSql(f.op, f.column)); continue; }
    if (f.op === 'between') {
      params.push(f.value[0]); params.push(f.value[1]);
      where.push(opToSql('between', f.column, `$${params.length - 1}`, `$${params.length}`));
      continue;
    }
    if (f.op === 'in') {
      params.push(f.value.map(String));
      where.push(opToSql('in', f.column, `$${params.length}`));
      continue;
    }
    if (f.op === 'ilike') { params.push(`%${String(f.value)}%`); }
    else { params.push(f.value); }
    where.push(opToSql(f.op, f.column, `$${params.length}`));
  }
  const order = spec.order_by ? ` ORDER BY ${spec.order_by.column} ${spec.order_by.direction === 'asc' ? 'ASC' : 'DESC'}` : ' ORDER BY updated_at DESC';
  return { sql: `SELECT ${tableDef.select} FROM ${spec.table} WHERE ${where.join(' AND ')}${order} LIMIT 25`, params };
}

export async function handler(req, ctx) {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const query = body?.query;
  const workspace_id = body?.workspace_id;
  if (!query || typeof query !== 'string') return jsonResponse(400, { error: 'query required' });
  if (!workspace_id || typeof workspace_id !== 'string') return jsonResponse(400, { error: 'workspace_id required' });

  console.log('[ai-search] query=%s ws=%s user=%s', query.slice(0, 120), workspace_id, ctx.user.id);

  const mem = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspace_id, ctx.user.id],
  );
  if (mem.rows.length === 0) {
    console.warn('[ai-search] not_a_member');
    return jsonResponse(403, { error: 'not_a_member' });
  }

  const prompt = `You translate a user's natural-language CRM query into a JSON filter spec. Reply with strict JSON only — no prose, no fences.

SCHEMA (whitelisted columns per table):
${JSON.stringify(SCHEMA, null, 2)}

ALLOWED OPS: ${[...ALLOWED_OPS].join(', ')}

OUTPUT SHAPE:
{
  "table": "companies" | "people" | "deals",
  "filters": [ {"column": "<col>", "op": "<op>", "value": <scalar | array>} ],
  "order_by": {"column": "<col>", "direction": "asc" | "desc"} | null
}

Guidance:
- Choose exactly ONE table.
- Prefer ilike for fuzzy text matches.
- For "open deals" use {"column":"stage","op":"in","value":["lead","qualified","proposal","negotiation"]}.
- For date ranges use ISO date strings relative to now=${new Date().toISOString()}.

USER QUERY:
${query}`;

  let aiRes;
  try {
    aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
        temperature: 0,
      }),
    });
  } catch (e) {
    console.error('[ai-search] fetch_threw', String(e?.message ?? e));
    return jsonResponse(502, { error: 'ai_fetch_threw', detail: String(e?.message ?? e) });
  }

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    console.error('[ai-search] upstream_non_ok status=%d body=%s', aiRes.status, errText.slice(0, 500));
    return jsonResponse(502, { error: 'ai_call_failed', upstream_status: aiRes.status, detail: errText.slice(0, 500) });
  }

  let aiJson;
  try {
    aiJson = await aiRes.json();
  } catch (e) {
    console.error('[ai-search] upstream_json_parse_fail', String(e?.message ?? e));
    return jsonResponse(502, { error: 'ai_upstream_json_parse', detail: String(e?.message ?? e) });
  }

  const content = (aiJson?.choices?.[0]?.message?.content ?? '').trim();
  if (!content) {
    console.error('[ai-search] empty_content full=%s', JSON.stringify(aiJson).slice(0, 500));
    return jsonResponse(502, { error: 'ai_empty_content' });
  }
  console.log('[ai-search] ai_content=%s', content.slice(0, 400));

  let spec;
  try {
    const fenced = content.match(/\{[\s\S]*\}/);
    spec = JSON.parse(fenced ? fenced[0] : content);
  } catch (e) {
    console.error('[ai-search] bad_json content=%s', content.slice(0, 400));
    return jsonResponse(502, { error: 'ai_bad_json', sample: content.slice(0, 200) });
  }
  const v = validateSpec(spec);
  if (!v.ok) {
    console.warn('[ai-search] spec_invalid detail=%s spec=%s', v.error, JSON.stringify(spec).slice(0, 300));
    return jsonResponse(422, { error: 'spec_invalid', detail: v.error, spec });
  }

  const { sql, params } = buildSql(spec, workspace_id);
  let rows;
  try {
    const r = await ctx.db.query(sql, params);
    rows = r.rows;
  } catch (e) {
    console.error('[ai-search] query_failed sql=%s err=%s', sql, String(e?.message ?? e));
    return jsonResponse(500, { error: 'query_failed', detail: String(e?.message ?? e), spec, sql });
  }

  console.log('[ai-search] ok count=%d table=%s', rows.length, spec.table);
  return jsonResponse(200, { table: spec.table, spec, rows, count: rows.length });
}

