export async function handler(req, ctx) {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const companyId = body?.company_id;
  if (!companyId || typeof companyId !== 'string') {
    return new Response(JSON.stringify({ error: 'company_id required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  // Runs as butterbase_user — RLS will return zero rows if caller can't see this company.
  const c = await ctx.db.query(
    'SELECT id, workspace_id, name, domain, industry, employee_count, location, description FROM companies WHERE id = $1',
    [companyId],
  );
  if (c.rows.length === 0) {
    return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  }
  const company = c.rows[0];

  const [notes, deals, activities] = await Promise.all([
    ctx.db.query(
      `SELECT body, created_at FROM notes
         WHERE entity_type = 'company' AND entity_id = $1
         ORDER BY created_at DESC LIMIT 5`,
      [companyId],
    ),
    ctx.db.query(
      `SELECT name, stage, amount_cents, currency, close_date
         FROM deals WHERE company_id = $1
         ORDER BY updated_at DESC LIMIT 10`,
      [companyId],
    ),
    ctx.db.query(
      `SELECT kind, payload, created_at FROM activities
         WHERE entity_type IN ('company','deal','note','meeting','person')
           AND workspace_id = $1
           AND (entity_id = $2 OR payload->>'company_id' = $2::text)
         ORDER BY created_at DESC LIMIT 10`,
      [company.workspace_id, companyId],
    ),
  ]);

  const prompt = `You are a CRM assistant. Write a concise 2-sentence overview of the company below, focused on who they are and the current state of our relationship with them. Be specific. No filler.

COMPANY
${JSON.stringify(company, null, 2)}

RECENT NOTES (newest first)
${notes.rows.map((n) => `- (${n.created_at}) ${n.body}`).join('\n') || '(none)'}

DEALS
${deals.rows.map((d) => `- ${d.name} — stage=${d.stage} amount=${d.amount_cents ?? '?'}${d.currency} close=${d.close_date ?? '?'}`).join('\n') || '(none)'}

RECENT ACTIVITY
${activities.rows.map((a) => `- (${a.created_at}) ${a.kind}`).join('\n') || '(none)'}

Return only the 2 sentences. No preamble, no headers.`;

  const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 240,
      temperature: 0.4,
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return new Response(JSON.stringify({ error: 'ai_call_failed', detail: errText.slice(0, 500) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }

  const aiJson = await aiRes.json();
  const summary = aiJson?.choices?.[0]?.message?.content?.trim?.() ?? '';

  if (summary) {
    // Best-effort cache; RLS will allow because caller is a workspace member.
    await ctx.db.query(
      'UPDATE companies SET ai_summary = $1, ai_summary_at = now(), updated_at = now() WHERE id = $2',
      [summary, companyId],
    ).catch(() => { /* swallow — cache is non-essential */ });
  }

  return new Response(JSON.stringify({ summary }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

