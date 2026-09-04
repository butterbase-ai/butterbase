const ALLOWED_OPS = new Set([
  'eq','neq','contains','starts_with','gt','gte','lt','lte','is_null','not_null','in','between',
]);

const BUILTIN = {
  people: [
    { slug: 'first_name', kind: 'text' }, { slug: 'last_name', kind: 'text' },
    { slug: 'email', kind: 'text' }, { slug: 'title', kind: 'text' },
    { slug: 'phone', kind: 'text' }, { slug: 'linkedin_url', kind: 'url' },
    { slug: 'created_at', kind: 'date' }, { slug: 'updated_at', kind: 'date' },
  ],
  companies: [
    { slug: 'name', kind: 'text' }, { slug: 'domain', kind: 'text' },
    { slug: 'industry', kind: 'text' }, { slug: 'location', kind: 'text' },
    { slug: 'employee_count', kind: 'number' }, { slug: 'description', kind: 'text' },
    { slug: 'linkedin_url', kind: 'url' }, { slug: 'created_at', kind: 'date' },
    { slug: 'updated_at', kind: 'date' },
  ],
  deals: [
    { slug: 'name', kind: 'text' }, { slug: 'stage', kind: 'enum' },
    { slug: 'amount_cents', kind: 'number' }, { slug: 'currency', kind: 'text' },
    { slug: 'close_date', kind: 'date' }, { slug: 'created_at', kind: 'date' },
    { slug: 'updated_at', kind: 'date' },
  ],
  meetings: [
    { slug: 'title', kind: 'text' }, { slug: 'location', kind: 'text' },
    { slug: 'starts_at', kind: 'date' }, { slug: 'ends_at', kind: 'date' },
    { slug: 'created_at', kind: 'date' },
  ],
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function validateFilter(f, fieldSlugs) {
  if (!f || typeof f !== 'object') return 'shape';
  if (typeof f.field !== 'string' || !fieldSlugs.has(f.field)) return `bad_field:${f.field}`;
  if (!ALLOWED_OPS.has(f.op)) return `bad_op:${f.op}`;
  if (f.op === 'between' && (!Array.isArray(f.value) || f.value.length !== 2)) return 'between_needs_pair';
  if (f.op === 'in' && (!Array.isArray(f.value) || f.value.length === 0)) return 'in_needs_array';
  return null;
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  let body;
  try { body = await req.json(); } catch { body = {}; }

  const { object_type, prompt, workspace_id, custom_fields } = body ?? {};
  if (!BUILTIN[object_type]) return json(400, { error: 'bad_object_type' });
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return json(400, { error: 'prompt required' });
  if (!workspace_id) return json(400, { error: 'workspace_id required' });

  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspace_id, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });

  const cfs = Array.isArray(custom_fields)
    ? custom_fields.filter((c) => c && typeof c.id === 'string' && typeof c.slug === 'string' && typeof c.kind === 'string')
    : [];

  const allFields = [
    ...BUILTIN[object_type].map((f) => ({ slug: f.slug, kind: f.kind, label: f.slug.replace(/_/g, ' '), ref: f.slug })),
    ...cfs.map((c) => ({ slug: `cf:${c.id}`, kind: c.kind, label: c.name ?? c.slug, ref: `cf:${c.id}` })),
  ];
  const fieldSlugs = new Set(allFields.map((f) => f.slug));

  const aiPrompt = `Translate a CRM filter request into a JSON Filter DSL.

OBJECT: ${object_type}
NOW: ${new Date().toISOString()}

AVAILABLE FIELDS (use the ref string verbatim as the "field" value):
${allFields.map((f) => `- ref="${f.ref}" label="${f.label}" kind=${f.kind}`).join('\n')}

ALLOWED OPS: ${[...ALLOWED_OPS].join(', ')}

OUTPUT SHAPE (strict JSON, no prose, no fences):
{
  "filters": [ {"field":"<ref>","op":"<op>","value": <scalar|array|omitted>} ],
  "suggested_name": "<short human label for this filter set>",
  "sort": {"field":"<ref>","direction":"asc"|"desc"} | null
}

Guidance:
- Prefer "contains" / "starts_with" for text.
- For "open deals" use {"field":"stage","op":"in","value":["lead","qualified","proposal","negotiation"]}.
- For date ranges like "this week", emit ISO timestamps and use gte/lte or between.
- For custom fields, use the "cf:<id>" ref shown above.
- Keep filters minimal — only what's needed to answer the prompt.

PROMPT:
${prompt}`;

  const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: aiPrompt }],
      max_tokens: 600,
      temperature: 0,
    }),
  });
  if (!aiRes.ok) {
    const detail = await aiRes.text();
    return json(502, { error: 'ai_call_failed', detail: detail.slice(0, 500) });
  }
  const aiJson = await aiRes.json();
  const raw = (aiJson?.choices?.[0]?.message?.content ?? '').trim();
  let parsed;
  try {
    const fenced = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(fenced ? fenced[0] : raw);
  } catch (e) {
    return json(502, { error: 'ai_bad_json', sample: raw.slice(0, 200) });
  }

  const filters = Array.isArray(parsed.filters) ? parsed.filters : [];
  if (filters.length > 8) return json(422, { error: 'too_many_filters' });
  for (const f of filters) {
    const err = validateFilter(f, fieldSlugs);
    if (err) return json(422, { error: 'filter_invalid', detail: err, filter: f });
  }
  let sort = null;
  if (parsed.sort && typeof parsed.sort === 'object') {
    if (!fieldSlugs.has(parsed.sort.field) || !['asc','desc'].includes(parsed.sort.direction)) {
      sort = null;
    } else { sort = { field: parsed.sort.field, direction: parsed.sort.direction }; }
  }

  return json(200, {
    object_type,
    filters,
    suggested_name: typeof parsed.suggested_name === 'string' ? parsed.suggested_name.slice(0, 80) : prompt.slice(0, 60),
    sort,
  });
}

