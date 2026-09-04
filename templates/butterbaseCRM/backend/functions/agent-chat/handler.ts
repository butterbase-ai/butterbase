interface AgentChatBody {
  thread_id?: string | null;
  workspace_id?: string;
  mode?: 'onboarding' | 'copilot';
  user_message?: string;
  client_context?: { route?: string; entity?: { type: string; id: string } | null };
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

type ToolDef = { name: string; description: string; input_schema: any };
type ToolOutcome = { ok: true; result: any; summary: string } | { ok: false; error: string };

export default async function handler(req: Request, ctx: any): Promise<Response> {
  if (!ctx.user) return jsonResponse(401, { error: 'unauthorized' });
  let body: AgentChatBody;
  try { body = await req.json(); } catch { body = {}; }
  const userMessage = body.user_message;
  if (typeof userMessage !== 'string' || userMessage.length === 0) return jsonResponse(400, { error: 'user_message required' });

  let threadId: string | null = body.thread_id ?? null;
  let workspaceId: string;
  let mode: 'onboarding' | 'copilot';
  let createdThread = false;

  if (!threadId) {
    if (!body.workspace_id) return jsonResponse(400, { error: 'workspace_id required when creating thread' });
    mode = body.mode === 'onboarding' ? 'onboarding' : 'copilot';
    workspaceId = body.workspace_id;
    const t = await ctx.db.query(`INSERT INTO agent_threads (workspace_id, user_id, mode) VALUES ($1, $2, $3) RETURNING id`, [workspaceId, ctx.user.id, mode]);
    threadId = t.rows[0].id;
    createdThread = true;
  } else {
    const t = await ctx.db.query(`SELECT id, workspace_id, mode FROM agent_threads WHERE id = $1`, [threadId]);
    if (t.rows.length === 0) return jsonResponse(404, { error: 'thread_not_found' });
    workspaceId = t.rows[0].workspace_id;
    mode = t.rows[0].mode;
  }

  const lockKey = `agent_thread_lock:${threadId}`;
  const acquired = await ctx.kv.setnx(lockKey, '1', { ttl: 30 });
  if (!acquired) { console.warn(`[agent-chat] thread_busy thread=${threadId}`); return jsonResponse(409, { error: 'thread_busy' }); }

  const today = new Date().toISOString().slice(0, 10);
  const budgetKey = `agent_budget:${ctx.user.id}:${today}`;
  const usedToday = (await ctx.kv.get<number>(budgetKey)) ?? 0;
  if (usedToday > 300_000) {
    console.warn(`[agent-chat] budget_exceeded user=${ctx.user.id} usedToday=${usedToday}`);
    await ctx.kv.del(lockKey);
    return jsonResponse(429, { error: 'budget_exceeded' });
  }

  const um = await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, content) VALUES ($1, $2, 'user', $3) RETURNING id`, [threadId, workspaceId, userMessage]);

  const history = await ctx.db.query(`SELECT role, content, tool_calls, tool_results, ui_event FROM agent_messages WHERE thread_id = $1 ORDER BY created_at ASC LIMIT 40`, [threadId]);

  const ctxLine = body.client_context?.route ? `The user is on \`${body.client_context.route}\`${body.client_context.entity ? ` looking at ${body.client_context.entity.type} ${body.client_context.entity.id}` : ''}.` : '';
  const etiquette = ' Tool-use etiquette: cite which tool you used in 5 words max; never invent ids; if a read returns nothing, say so plainly. Reads run silently; propose_* and confirm_action ui_events are user-visible.';

  const systemPrompt = mode === 'onboarding'
    ? `You are the welcome agent for butterbaseCRM. The workspace was just created and is empty. Two goals at once: (1) interview the user about their sales workflow — who they sell to, pipeline stages, cadence; (2) populate the workspace by suggesting Gmail/Calendar linking, importing substrate entities, creating the first company/person/deal. Move fast. Ask ONE question at a time. Prefer ask_user with structured options. Call remember_fact for preferences worth keeping. End by calling mark_onboarded once the workspace has at least one company AND one of: a linked integration, an imported substrate entity, or a first deal.${etiquette}`
    : `You are a CRM copilot embedded inside butterbaseCRM. ${ctxLine} Be terse, do the work, surface what you find. Search freely. Propose writes; don't lecture. For "who…"/"status of…"/"summarize…" → read tools + short direct answer. For "create…"/"remind me…"/"log…" → propose_* tool + brief confirm. When the user wants to post/announce/share something on social media → gather real context with your read tools first, then call draft_social_post with platform-tailored copy (it surfaces a draft the user reviews — it does not post).${etiquette}`;

  const messages: any[] = [{ role: 'system', content: systemPrompt }];
  for (const row of history.rows) {
    if (row.role === 'user' && row.content) messages.push({ role: 'user', content: row.content });
    else if (row.role === 'assistant') {
      const hasContent = !!row.content;
      const hasToolCalls = !!row.tool_calls;
      if (!hasContent && !hasToolCalls) continue;
      const m: any = { role: 'assistant', content: row.content || null };
      if (hasToolCalls) m.tool_calls = row.tool_calls;
      messages.push(m);
    } else if (row.role === 'tool' && row.tool_results) {
      const tr = row.tool_results;
      messages.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: JSON.stringify(tr.outcome?.ok ? tr.outcome.result : { error: tr.outcome?.error ?? 'unknown' }) });
    } else if (row.role === 'system_event' && row.ui_event) {
      messages.push({ role: 'user', content: `[ui:${row.ui_event.kind}] ${JSON.stringify(row.ui_event.payload).slice(0, 400)}` });
    }
  }

  const insertProposal = async (toolName: string, payload: any, rationale: string, write: (s: string) => void): Promise<string> => {
    const r = await ctx.db.query(`INSERT INTO agent_proposals (thread_id, workspace_id, proposed_by, tool_name, payload, rationale) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [threadId, workspaceId, ctx.user.id, toolName, JSON.stringify(payload), rationale]);
    const id = r.rows[0].id;
    write(sseEvent('proposal_created', { proposal_id: id, tool_name: toolName, payload, rationale }));
    return id;
  };

  const emitConfirmAction = async (toolName: string, label: string, endpoint: string, body2: any, costEstimate: string | null, write: (s: string) => void): Promise<void> => {
    const payload = { tool_name: toolName, label, endpoint, body: body2, cost_estimate: costEstimate };
    write(sseEvent('ui_event', { kind: 'confirm_action', payload }));
    await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`, [threadId, workspaceId, JSON.stringify({ kind: 'confirm_action', payload })]);
  };

  const tools: ToolDef[] = [];
  const dispatch: Record<string, (args: any, helpers: { write: (s: string) => void }) => Promise<ToolOutcome>> = {};

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidParam = (field: string) => ({ type: 'string', format: 'uuid', description: `UUID of the ${field}, as returned by search_workspace. NEVER pass a name, slug, or domain.` });
  const requireUuid = (val: unknown, field: string): { ok: true; id: string } | { ok: false; error: string } => {
    const s = typeof val === 'string' ? val.trim() : '';
    if (!s) return { ok: false, error: `${field}_required` };
    if (!UUID_RE.test(s)) return { ok: false, error: `${field} must be a UUID (got "${s.slice(0, 40)}"). Call search_workspace first to get the real id.` };
    return { ok: true, id: s };
  };

  // Read tools
  tools.push({
    name: 'search_workspace',
    description: 'List or search companies and people in the workspace (substrate entities). Returns up to 10 of each, filtered by your query. When the user wants a listing, pass an empty string for query to get recent entities. Only pass a non-empty query when you have a specific name/domain/email/title fragment. NEVER pass category words like "companies", "all", "my", "list" as the query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional. A specific name/domain/email/title fragment to match. Pass "" (empty string) to list recent entities.' },
        scope: { type: 'string', enum: ['all', 'companies', 'people', 'deals'], description: 'Which entity type(s) to search. Default all. (deals are not available as a relational table here.)' },
      },
      required: [],
    },
  });
  dispatch['search_workspace'] = async (args: any) => {
    // Companies/people are substrate entities (this workspace migrated off the
    // relational companies/people/deals tables) — read them via ctx.substrate.
    if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
    const rawQuery = typeof args?.query === 'string' ? args.query.trim().slice(0, 200) : '';
    const scope = args?.scope === 'companies' || args?.scope === 'people' || args?.scope === 'deals' ? args.scope : 'all';
    const GENERIC = new Set(['all','any','my','me','our','list','show','find','get','recent','latest','last','some','top','best','companies','people','deals','contacts','accounts','company','person','deal','everyone','everything']);
    const term = (rawQuery.length >= 2 && !GENERIC.has(rawQuery.toLowerCase())) ? rawQuery.toLowerCase() : null;

    const matches = (e: any) => {
      if (!term) return true;
      const hay = `${e?.display_name ?? ''} ${e?.primary_email ?? ''} ${JSON.stringify(e?.attrs ?? {})}`.toLowerCase();
      return hay.includes(term);
    };
    const fetchType = async (t: string) => {
      const ents = await ctx.substrate.findEntities({ type: t, limit: 100 }).catch(() => []);
      return (ents ?? []).filter((e: any) => !e?.attrs?.deleted_at && matches(e)).slice(0, 10);
    };

    const wantC = scope === 'all' || scope === 'companies';
    const wantP = scope === 'all' || scope === 'people';
    const [companies, people] = await Promise.all([
      wantC ? fetchType('company') : Promise.resolve([]),
      wantP ? fetchType('person') : Promise.resolve([]),
    ]);

    const out: any = {};
    if (wantC) out.companies = companies.map((e: any) => ({ id: e.id, name: e.display_name, domain: e.attrs?.domain ?? null, industry: e.attrs?.industry ?? null, location: e.attrs?.location ?? null, description: e.attrs?.description ?? null }));
    if (wantP) out.people = people.map((e: any) => ({ id: e.id, name: e.display_name, email: e.primary_email ?? e.attrs?.email ?? null, title: e.attrs?.title ?? null, company: e.attrs?.company_name ?? e.attrs?.company ?? null }));

    const parts: string[] = [];
    if (wantC) parts.push(`${out.companies.length} companies`);
    if (wantP) parts.push(`${out.people.length} people`);
    return { ok: true, result: out, summary: parts.join(', ') || 'no results' };
  };

  tools.push({ name: 'get_company', description: 'Fetch a company entity by id (the id returned by search_workspace), including its stored attributes.', input_schema: { type: 'object', properties: { company_id: { type: 'string', description: 'Entity id from search_workspace.' } }, required: ['company_id'] } });
  dispatch['get_company'] = async (args: any) => {
    if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
    const id = String(args?.company_id ?? '').trim();
    if (!id) return { ok: false, error: 'company_id_required' };
    const ent = await ctx.substrate.getEntity(id).catch(() => null);
    if (!ent) return { ok: false, error: 'not_found' };
    return { ok: true, result: { company: { id: ent.id, name: ent.display_name, ...(ent.attrs ?? {}) } }, summary: `${ent.display_name}` };
  };

  tools.push({ name: 'get_pipeline_summary', description: 'Returns count and sum(amount_cents) per stage for all deals in the current workspace.', input_schema: { type: 'object', properties: {} } });
  dispatch['get_pipeline_summary'] = async () => {
    try {
      const r = await ctx.db.query(`SELECT stage, COUNT(*)::int as count, COALESCE(SUM(amount_cents),0)::bigint as total_amount_cents FROM deals WHERE workspace_id = $1 GROUP BY stage ORDER BY stage`, [workspaceId]);
      return { ok: true, result: { stages: r.rows }, summary: `Pipeline: ${r.rows.length} stages` };
    } catch {
      return { ok: false, error: 'pipeline summary is unavailable in this workspace (deals are not in a relational table here). Use search_workspace or search_substrate_memory.' };
    }
  };

  tools.push({ name: 'get_person', description: 'Fetch a person entity by id (the id returned by search_workspace), including stored attributes.', input_schema: { type: 'object', properties: { person_id: { type: 'string', description: 'Entity id from search_workspace.' } }, required: ['person_id'] } });
  dispatch['get_person'] = async (args: any) => {
    if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
    const id = String(args?.person_id ?? '').trim();
    if (!id) return { ok: false, error: 'person_id_required' };
    const ent = await ctx.substrate.getEntity(id).catch(() => null);
    if (!ent) return { ok: false, error: 'not_found' };
    return { ok: true, result: { person: { id: ent.id, name: ent.display_name, email: ent.primary_email ?? null, ...(ent.attrs ?? {}) } }, summary: `${ent.display_name}` };
  };

  tools.push({ name: 'get_deal', description: 'Fetch a deal by id. (Not available in this workspace — deals are not stored relationally here.)', input_schema: { type: 'object', properties: { deal_id: { type: 'string' } }, required: ['deal_id'] } });
  dispatch['get_deal'] = async () => {
    // Deals are not in a relational table in this workspace (substrate migration).
    return { ok: false, error: 'deal lookup is unavailable in this workspace. Use search_workspace (companies/people), list_meetings, or search_substrate_memory.' };
  };

  tools.push({ name: 'list_recent_activity', description: 'List recent activity events. Optionally filter by entity.', input_schema: { type: 'object', properties: { limit: { type: 'number' }, entity_type: { type: 'string' }, entity_id: { type: 'string' } } } });
  dispatch['list_recent_activity'] = async (args: any) => {
    try {
      const limit = Math.min(50, Math.max(1, Math.trunc(args?.limit ?? 20)));
      const filters: string[] = ['workspace_id = $1']; const params: any[] = [workspaceId];
      if (args?.entity_type) { params.push(args.entity_type); filters.push(`entity_type = $${params.length}`); }
      if (args?.entity_id)   { params.push(args.entity_id);   filters.push(`entity_id = $${params.length}`); }
      params.push(limit);
      const r = await ctx.db.query(`SELECT kind, entity_type, entity_id, payload, actor_user_id, created_at FROM activities WHERE ${filters.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`, params);
      return { ok: true, result: { events: r.rows }, summary: `${r.rows.length} events` };
    } catch {
      return { ok: false, error: 'activity log is unavailable in this workspace. Use search_workspace or search_substrate_memory.' };
    }
  };

  tools.push({ name: 'list_meetings', description: 'List meetings in a time range.', input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, scope: { type: 'string', enum: ['mine', 'all'] } } } });
  dispatch['list_meetings'] = async (args: any) => {
    // Meetings live in substrate (type='event'). Returns substrate entity ids.
    if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
    const from = typeof args?.from === 'string' ? args.from : null;
    const to = typeof args?.to === 'string' ? args.to : null;
    const events = await ctx.substrate.findEntities({ type: 'event', limit: 200 }).catch(() => []);
    const filtered = (events ?? []).filter((e: any) => {
      const a = e.attrs ?? {};
      if (a.deleted_at) return false;
      if (String(a.workspace_id ?? '') !== String(workspaceId)) return false;
      if (from && !(String(a.starts_at ?? '') >= from)) return false;
      if (to && !(String(a.starts_at ?? '') <= to)) return false;
      return true;
    });
    filtered.sort((a: any, b: any) => String(b.attrs?.starts_at ?? '').localeCompare(String(a.attrs?.starts_at ?? '')));
    const rows = filtered.slice(0, 25).map((e: any) => ({
      id: e.id,
      title: e.attrs?.title ?? e.display_name ?? null,
      starts_at: e.attrs?.starts_at ?? null,
      ends_at: e.attrs?.ends_at ?? null,
      location: e.attrs?.location ?? null,
      company_id: e.attrs?.company_id ?? null,
      deal_id: e.attrs?.deal_id ?? null,
    }));
    return { ok: true, result: { meetings: rows }, summary: `${rows.length} meetings` };
  };

  tools.push({ name: 'list_integrations', description: 'Lists which third-party providers the user has connected for this workspace.', input_schema: { type: 'object', properties: {} } });
  dispatch['list_integrations'] = async () => {
    const r = await ctx.db.query(`SELECT toolkit_slug, composio_account_id, connected_at FROM workspace_integrations WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, ctx.user.id]);
    const slugs = r.rows.map((row: any) => row.toolkit_slug);
    return { ok: true, result: { connected: slugs, details: r.rows }, summary: `Connected: ${slugs.join(', ') || 'none'}` };
  };

  tools.push({ name: 'search_substrate_memory', description: 'Search the user-level long-term memory (decisions, commitments, learnings, substrate entities).', input_schema: { type: 'object', properties: { query: { type: 'string' }, kinds: { type: 'array', items: { type: 'string', enum: ['decisions', 'commitments', 'learnings', 'entities'] } }, limit: { type: 'number' } }, required: ['query'] } });
  dispatch['search_substrate_memory'] = async (args: any) => {
    if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
    const query = String(args?.query ?? '').slice(0, 400);
    const kinds = Array.isArray(args?.kinds) ? args.kinds : undefined;
    const limit = Math.min(15, Math.max(1, Math.trunc(args?.limit ?? 5)));
    const wantEntities = kinds?.includes('entities');
    const memKinds = kinds?.filter((k: string) => k !== 'entities');
    const [mem, ents] = await Promise.all([
      ctx.substrate.searchMemory(query, { kinds: memKinds, limit }).catch(() => null),
      wantEntities ? ctx.substrate.findEntities({ query, limit }).catch(() => null) : Promise.resolve(null),
    ]);
    return { ok: true, result: { memory: mem ?? [], entities: ents ?? [] }, summary: `Memory hits: ${(mem ?? []).length}, entities: ${(ents ?? []).length}` };
  };

  // Conversational tools
  tools.push({ name: 'ask_user', description: 'Ask the user a structured question. Provide options for multiple-choice or allow free text.', input_schema: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'] } }, allow_free_text: { type: 'boolean' } }, required: ['question'] } });
  dispatch['ask_user'] = async (args: any, { write }) => {
    const question = String(args?.question ?? '').slice(0, 400);
    if (!question) return { ok: false, error: 'question_required' };
    const options = Array.isArray(args?.options) ? args.options.slice(0, 6) : undefined;
    const allow_free_text = args?.allow_free_text !== false;
    const payload = { question, options, allow_free_text };
    write(sseEvent('ui_event', { kind: 'ask_user', payload }));
    await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`, [threadId, workspaceId, JSON.stringify({ kind: 'ask_user', payload })]);
    return { ok: true, result: { rendered: true }, summary: 'Asked question' };
  };

  tools.push({ name: 'suggest_next_step', description: 'Surface a clickable next-step chip to the user.', input_schema: { type: 'object', properties: { label: { type: 'string' }, action: { type: 'object', properties: { type: { type: 'string', enum: ['navigate', 'open_proposal', 'link_account'] }, params: { type: 'object' } }, required: ['type'] } }, required: ['label', 'action'] } });
  dispatch['suggest_next_step'] = async (args: any, { write }) => {
    const label = String(args?.label ?? '').slice(0, 80);
    const action = args?.action;
    if (!label || !action?.type) return { ok: false, error: 'malformed' };
    const payload = { label, action };
    write(sseEvent('ui_event', { kind: 'suggest_next_step', payload }));
    await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`, [threadId, workspaceId, JSON.stringify({ kind: 'suggest_next_step', payload })]);
    return { ok: true, result: { rendered: true }, summary: `Suggested: ${label}` };
  };

  tools.push({ name: 'draft_social_post', description: 'Draft social media posts for the user to review and publish. FIRST gather real context with your read tools (search_workspace, get_company, search_substrate_memory, list_meetings, …), THEN write distinct, platform-tailored copy. Respect Twitter\'s 280-char limit; keep LinkedIn substantive and professional; for Reddit propose a fitting subreddit + title (the user will verify them). This does NOT post anything — it surfaces a draft card the user reviews and edits in the composer before publishing.', input_schema: { type: 'object', properties: {
    channels: { type: 'array', items: { type: 'string', enum: ['twitter', 'linkedin', 'reddit'] }, description: 'Which connected channels to draft for. Omit to draft for all connected channels.' },
    body: { type: 'string', description: 'Shared/default post body, used for any targeted channel that has no per-channel body. Optional if every targeted channel has its own body (e.g. twitter.body).' },
    twitter: { type: 'object', properties: { body: { type: 'string' } }, description: 'Twitter-specific body (must be <= 280 chars).' },
    linkedin: { type: 'object', properties: { body: { type: 'string' } }, description: 'LinkedIn-specific body.' },
    reddit: { type: 'object', properties: { title: { type: 'string' }, subreddit: { type: 'string' }, body: { type: 'string' } }, description: 'Reddit title (required if reddit is targeted), a suggested subreddit (user verifies), and optional reddit-specific body.' },
    rationale: { type: 'string', description: 'One short sentence on why these drafts / what data they draw from. Shown on the card.' },
  }, required: [] } });
  dispatch['draft_social_post'] = async (args: any, { write }) => {
    const body = String(args?.body ?? '').trim();
    const VALID = ['twitter', 'linkedin', 'reddit'];
    const connRes = await ctx.db.query(`SELECT toolkit_slug FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = ANY($2::text[])`, [workspaceId, VALID]);
    const connected: string[] = connRes.rows.map((r: any) => r.toolkit_slug);
    if (connected.length === 0) return { ok: false, error: 'no_social_channels_connected' };
    const requested: string[] = (Array.isArray(args?.channels) && args.channels.length > 0)
      ? args.channels.filter((c: string) => VALID.includes(c))
      : connected;
    const channels = requested.filter((c: string) => connected.includes(c));
    if (channels.length === 0) return { ok: false, error: `none of the requested channels are connected (connected: ${connected.join(', ') || 'none'})` };
    const overrides: any = {};
    if (channels.includes('twitter') && args?.twitter?.body) overrides.twitter = { body: String(args.twitter.body) };
    if (channels.includes('linkedin') && args?.linkedin?.body) overrides.linkedin = { body: String(args.linkedin.body) };
    if (channels.includes('reddit')) {
      overrides.reddit = {
        title: String(args?.reddit?.title ?? '').slice(0, 300),
        subreddit: String(args?.reddit?.subreddit ?? '').replace(/^\/?r\//i, '').replace(/\//g, ''),
        ...(args?.reddit?.body ? { body: String(args.reddit.body) } : {}),
      };
    }
    // Each channel resolves its copy from its own override, falling back to the shared `body`.
    // Require content per targeted channel — NOT a mandatory top-level `body` — so a
    // single-platform draft via e.g. `twitter.body` alone is valid (matches the design spec).
    const missing = channels.filter((c) => !(overrides[c]?.body) && !body);
    if (missing.length > 0) return { ok: false, error: `no copy for channel(s): ${missing.join(', ')} — provide a shared \`body\` or a per-channel body (e.g. ${missing[0]}.body)` };
    const payload = { channels, body, overrides, rationale: args?.rationale ? String(args.rationale).slice(0, 300) : null };
    write(sseEvent('ui_event', { kind: 'draft_social_post', payload }));
    await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`, [threadId, workspaceId, JSON.stringify({ kind: 'draft_social_post', payload })]);
    return { ok: true, result: { rendered: true, channels }, summary: `Drafted posts for ${channels.join(', ')}` };
  };

  tools.push({ name: 'remember_fact', description: 'Persist a long-term fact about the user (preference, goal, or process note). Survives across sessions.', input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['preference', 'goal', 'process_note'] }, summary: { type: 'string' }, rationale: { type: 'string' } }, required: ['kind', 'summary'] } });
  dispatch['remember_fact'] = async (args: any) => {
    if (!ctx.substrate) return { ok: false, error: 'substrate_not_linked' };
    const kind = String(args?.kind ?? 'preference');
    const summary = String(args?.summary ?? '').slice(0, 300);
    const rationale = args?.rationale ? String(args.rationale).slice(0, 600) : undefined;
    if (!summary) return { ok: false, error: 'summary_required' };
    try {
      const verdict = await ctx.substrate.propose('record_decision', { title: summary, kind: 'operational', rationale: rationale ?? `User-stated ${kind}` });
      return { ok: true, result: { verdict }, summary: `Remembered: ${summary.slice(0, 40)}` };
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  };

  // Write/proposal tools
  tools.push({ name: 'propose_create_company', description: 'Propose creating a new company. User confirms before any write.', input_schema: { type: 'object', properties: { name: { type: 'string' }, domain: { type: 'string' }, industry: { type: 'string' }, location: { type: 'string' }, employee_count: { type: 'integer' }, description: { type: 'string' }, rationale: { type: 'string' } }, required: ['name'] } });
  dispatch['propose_create_company'] = async (args: any, { write }) => {
    const name = String(args?.name ?? '').trim();
    if (!name) return { ok: false, error: 'name_required' };
    const payload: any = { name };
    for (const k of ['domain', 'industry', 'location', 'description']) { if (typeof args?.[k] === 'string' && args[k]) payload[k] = args[k]; }
    if (Number.isFinite(args?.employee_count)) payload.employee_count = Math.trunc(args.employee_count);
    const id = await insertProposal('propose_create_company', payload, String(args?.rationale ?? '').slice(0, 200), write);
    return { ok: true, result: { proposal_id: id }, summary: `Proposed: create company "${name}"` };
  };

  tools.push({ name: 'propose_create_person', description: 'Propose creating a new person.', input_schema: { type: 'object', properties: { first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, company_id: { type: 'string' }, title: { type: 'string' }, phone: { type: 'string' }, linkedin_url: { type: 'string' }, rationale: { type: 'string' } } } });
  dispatch['propose_create_person'] = async (args: any, { write }) => {
    const payload: any = {};
    for (const k of ['first_name', 'last_name', 'email', 'company_id', 'title', 'phone', 'linkedin_url']) { if (typeof args?.[k] === 'string' && args[k]) payload[k] = args[k]; }
    if (!payload.first_name && !payload.last_name && !payload.email) return { ok: false, error: 'identity_required' };
    const id = await insertProposal('propose_create_person', payload, String(args?.rationale ?? '').slice(0, 200), write);
    const display = [payload.first_name, payload.last_name].filter(Boolean).join(' ') || payload.email || 'unknown';
    return { ok: true, result: { proposal_id: id }, summary: `Proposed: add person "${display}"` };
  };

  tools.push({ name: 'propose_create_deal', description: 'Propose creating a new deal.', input_schema: { type: 'object', properties: { name: { type: 'string' }, company_id: { type: 'string' }, primary_person_id: { type: 'string' }, stage: { type: 'string', enum: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] }, amount_cents: { type: 'integer' }, currency: { type: 'string' }, close_date: { type: 'string' }, rationale: { type: 'string' } }, required: ['name'] } });
  dispatch['propose_create_deal'] = async (args: any, { write }) => {
    const name = String(args?.name ?? '').trim();
    if (!name) return { ok: false, error: 'name_required' };
    const payload: any = { name };
    for (const k of ['company_id', 'primary_person_id', 'stage', 'currency', 'close_date']) { if (typeof args?.[k] === 'string' && args[k]) payload[k] = args[k]; }
    if (Number.isFinite(args?.amount_cents)) payload.amount_cents = Math.trunc(args.amount_cents);
    const id = await insertProposal('propose_create_deal', payload, String(args?.rationale ?? '').slice(0, 200), write);
    return { ok: true, result: { proposal_id: id }, summary: `Proposed: create deal "${name}"` };
  };

  tools.push({ name: 'propose_update_deal_stage', description: 'Propose moving a deal to a new stage. The deal_id MUST be a UUID from search_workspace.', input_schema: { type: 'object', properties: { deal_id: uuidParam('deal'), stage: { type: 'string', enum: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] }, rationale: { type: 'string' } }, required: ['deal_id', 'stage'] } });
  dispatch['propose_update_deal_stage'] = async (args: any, { write }) => {
    const v = requireUuid(args?.deal_id, 'deal_id'); if (!v.ok) return v;
    const deal_id = v.id;
    const stage = String(args?.stage ?? '');
    if (!stage) return { ok: false, error: 'stage_required' };
    const id = await insertProposal('propose_update_deal_stage', { deal_id, stage }, String(args?.rationale ?? '').slice(0, 200), write);
    return { ok: true, result: { proposal_id: id }, summary: `Proposed: deal ${deal_id.slice(0, 8)} -> ${stage}` };
  };

  tools.push({ name: 'propose_add_note', description: 'Propose attaching a note to a company, person, deal, or meeting.', input_schema: { type: 'object', properties: { entity_type: { type: 'string', enum: ['company', 'person', 'deal', 'meeting'] }, entity_id: { type: 'string' }, body: { type: 'string' }, rationale: { type: 'string' } }, required: ['entity_type', 'entity_id', 'body'] } });
  dispatch['propose_add_note'] = async (args: any, { write }) => {
    const entity_type = String(args?.entity_type ?? ''); const entity_id = String(args?.entity_id ?? '');
    const noteBody = String(args?.body ?? '').slice(0, 4000);
    if (!entity_type || !entity_id || !noteBody) return { ok: false, error: 'missing_fields' };
    const id = await insertProposal('propose_add_note', { entity_type, entity_id, body: noteBody }, String(args?.rationale ?? '').slice(0, 200), write);
    return { ok: true, result: { proposal_id: id }, summary: `Proposed: note on ${entity_type}` };
  };

  tools.push({ name: 'propose_invite_member', description: 'Propose inviting a new teammate to the workspace.', input_schema: { type: 'object', properties: { email: { type: 'string' }, role: { type: 'string', enum: ['member', 'admin'] }, rationale: { type: 'string' } }, required: ['email'] } });
  dispatch['propose_invite_member'] = async (args: any, { write }) => {
    const email = String(args?.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return { ok: false, error: 'email_required' };
    const role = args?.role === 'admin' ? 'admin' : 'member';
    const id = await insertProposal('propose_invite_member', { email, role }, String(args?.rationale ?? '').slice(0, 200), write);
    return { ok: true, result: { proposal_id: id }, summary: `Proposed: invite ${email}` };
  };

  // Action tools (Phase 7)
  tools.push({ name: 'suggest_link_account', description: 'Suggest the user link a third-party account (Gmail, Google Calendar). Renders a button.', input_schema: { type: 'object', properties: { provider: { type: 'string', enum: ['gmail', 'google-calendar'] }, reason: { type: 'string' } }, required: ['provider', 'reason'] } });
  dispatch['suggest_link_account'] = async (args: any, { write }) => {
    const provider = String(args?.provider ?? '');
    const reason = String(args?.reason ?? '').slice(0, 200);
    if (!provider) return { ok: false, error: 'provider_required' };
    const payload = { provider, reason };
    write(sseEvent('ui_event', { kind: 'suggest_link_account', payload }));
    await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`, [threadId, workspaceId, JSON.stringify({ kind: 'suggest_link_account', payload })]);
    return { ok: true, result: { rendered: true }, summary: `Suggested linking ${provider}` };
  };

  tools.push({ name: 'mark_onboarded', description: 'Call once onboarding is complete. Flips the first-run flag and tells the frontend to leave the welcome screen.', input_schema: { type: 'object', properties: {} } });
  dispatch['mark_onboarded'] = async (_args: any, { write }) => {
    const key = `firstrun:${workspaceId}:${ctx.user.id}`;
    try { await ctx.kv.set(key, '1', { ttl: 60 * 60 * 24 * 365 }); } catch { /* swallow */ }
    write(sseEvent('ui_event', { kind: 'onboarding_complete', payload: {} }));
    await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, ui_event) VALUES ($1, $2, 'system_event', $3)`, [threadId, workspaceId, JSON.stringify({ kind: 'onboarding_complete', payload: {} })]);
    return { ok: true, result: { onboarded: true }, summary: 'Marked onboarding complete' };
  };

  tools.push({ name: 'trigger_gmail_ingest', description: 'Ask the user to confirm running a Gmail ingestion. Requires Gmail linked.', input_schema: { type: 'object', properties: { lookback_days: { type: 'number' } } } });
  dispatch['trigger_gmail_ingest'] = async (args: any, { write }) => {
    const lookback_days = Math.min(180, Math.max(1, Math.trunc(args?.lookback_days ?? 30)));
    await emitConfirmAction('trigger_gmail_ingest', `Ingest last ${lookback_days} days of Gmail`, '/fn/ingest-gmail', { lookback_days, workspace_id: workspaceId }, null, write);
    return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
  };

  tools.push({ name: 'trigger_calendar_ingest', description: 'Ask the user to confirm running a Calendar ingestion.', input_schema: { type: 'object', properties: { lookback_days: { type: 'number' }, lookahead_days: { type: 'number' } } } });
  dispatch['trigger_calendar_ingest'] = async (args: any, { write }) => {
    const lookback = Math.min(180, Math.max(1, Math.trunc(args?.lookback_days ?? 30)));
    const lookahead = Math.min(90, Math.max(0, Math.trunc(args?.lookahead_days ?? 30)));
    await emitConfirmAction('trigger_calendar_ingest', `Sync calendar (-${lookback}d to +${lookahead}d)`, '/fn/ingest-calendar', { lookback_days: lookback, lookahead_days: lookahead, workspace_id: workspaceId }, null, write);
    return { ok: true, result: { rendered: true }, summary: 'Awaiting confirmation' };
  };

  tools.push({ name: 'import_from_substrate', description: 'Ask the user to confirm importing a substrate entity (company or person) into the CRM.', input_schema: { type: 'object', properties: { entity_type: { type: 'string', enum: ['company', 'person'] }, substrate_entity_id: { type: 'string' } }, required: ['entity_type', 'substrate_entity_id'] } });
  dispatch['import_from_substrate'] = async (args: any, { write }) => {
    const entity_type = String(args?.entity_type ?? ''); const substrate_entity_id = String(args?.substrate_entity_id ?? '');
    if (!entity_type || !substrate_entity_id) return { ok: false, error: 'missing_fields' };
    await emitConfirmAction('import_from_substrate', `Import ${entity_type} from substrate`, '/fn/import-from-substrate', { entity_type, substrate_entity_id, workspace_id: workspaceId }, null, write);
    return { ok: true, result: { rendered: true }, summary: `Awaiting import confirmation` };
  };

  // NOTE: enrich_company / enrich_person / summarize_company / find_duplicates /
  // propose_deals were removed — their backing functions are post-substrate-migration
  // stubs or query dropped relational tables, so they only produced dead-end errors
  // (e.g. "company_id must be a UUID (got ent_…)"). Re-add once rewritten for substrate.

  // Streaming + tool loop
  const clientAbort = new AbortController();
  let lockReleased = false;
  const releaseLock = async () => {
    if (lockReleased) return;
    lockReleased = true;
    try { await ctx.kv.del(lockKey); } catch { /* swallow */ }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (s: string) => { try { controller.enqueue(enc.encode(s)); } catch { /* consumer gone */ } };
      let usage: any = null;
      let stopReason: string | null = null;
      try {
        if (createdThread) write(sseEvent('thread', { thread_id: threadId, mode }));
        write(sseEvent('user_message_id', { id: um.rows[0].id }));
        const placeholder = await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, content) VALUES ($1, $2, 'assistant', '') RETURNING id`, [threadId, workspaceId]);
        const assistantId = placeholder.rows[0].id;
        write(sseEvent('assistant_start', { message_id: assistantId }));

        let iteration = 0;
        let fullText = '';
        while (iteration < 8) {
          if (clientAbort.signal.aborted) { console.warn(`[agent-chat] client_aborted thread=${threadId} iter=${iteration}`); break; }
          iteration++;
          stopReason = null;
          if (iteration === 1) {
            console.log(`[agent-chat] iter=1 messages=${JSON.stringify(messages).slice(0, 1500)} toolCount=${tools.length}`);
          }
          const aiRes = await fetch(`${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
            body: JSON.stringify({
              model: 'anthropic/claude-haiku-4.5', messages, max_tokens: 800, stream: true,
              tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
            }),
            signal: clientAbort.signal,
          });
          if (!aiRes.ok || !aiRes.body) {
            const detail = aiRes.body ? (await aiRes.text()).slice(0, 500) : 'no body';
            console.error(`[agent-chat] gateway non-2xx: status=${aiRes.status} detail=${detail}`);
            write(sseEvent('error', { code: 'ai_gateway_error', message: detail })); break;
          }
          const reader = aiRes.body.getReader(); const dec = new TextDecoder();
          let buf = '';
          const pendingToolCalls: Record<string, { id: string; name: string; args_buffer: string; announced: boolean }> = {};
          while (true) {
            const { value, done } = await reader.read(); if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n'); buf = lines.pop() ?? '';
            for (const line of lines) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
              let chunk: any; try { chunk = JSON.parse(payload); } catch { continue; }
              const choice = chunk?.choices?.[0]; const delta = choice?.delta;
              if (typeof delta?.content === 'string' && delta.content.length > 0) {
                fullText += delta.content; write(sseEvent('assistant_delta', { text: delta.content }));
              }
              if (Array.isArray(delta?.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const key = String(tc.index ?? 0);
                  if (!pendingToolCalls[key]) {
                    pendingToolCalls[key] = { id: '', name: '', args_buffer: '', announced: false };
                  }
                  const entry = pendingToolCalls[key];
                  if (typeof tc.id === 'string' && tc.id) entry.id = tc.id;
                  if (typeof tc.function?.name === 'string' && tc.function.name) entry.name = tc.function.name;
                  if (typeof tc.function?.arguments === 'string') entry.args_buffer += tc.function.arguments;
                  if (!entry.announced && entry.name) {
                    entry.announced = true;
                    write(sseEvent('tool_call_start', { tool_call_id: entry.id || key, name: entry.name, args: {} }));
                  }
                }
              }
              if (choice?.finish_reason) stopReason = choice.finish_reason;
              if (chunk?.usage) usage = chunk.usage;
            }
          }
          console.log(`[agent-chat] iter=${iteration} stopReason=${stopReason} fullTextLen=${fullText.length} pendingTools=${Object.keys(pendingToolCalls).length}`);
          if (stopReason !== 'tool_calls' && stopReason !== 'tool_use') break;

          const assistantToolCallsForHistory: any[] = [];
          const toolMessagesForGateway: any[] = [];
          for (const key of Object.keys(pendingToolCalls)) {
            const tc = pendingToolCalls[key];
            if (!tc.name) continue;
            const callId = tc.id || `tc_${key}`;
            let args: any = {}; try { args = JSON.parse(tc.args_buffer || '{}'); } catch { args = {}; }
            assistantToolCallsForHistory.push({ id: callId, type: 'function', function: { name: tc.name, arguments: tc.args_buffer || '{}' } });
            const fn = dispatch[tc.name]; let outcome: ToolOutcome;
            if (!fn) outcome = { ok: false, error: `unknown_tool:${tc.name}` };
            else { try { outcome = await fn(args, { write }); } catch (e: any) { outcome = { ok: false, error: String(e?.message ?? e) }; } }
            write(sseEvent('tool_call_done', outcome.ok ? { tool_call_id: callId, ok: true, summary: outcome.summary } : { tool_call_id: callId, ok: false, error: outcome.error }));
            toolMessagesForGateway.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }) });
            await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, tool_results) VALUES ($1, $2, 'tool', $3)`, [threadId, workspaceId, JSON.stringify({ tool_call_id: callId, name: tc.name, args, outcome })]);
          }
          await ctx.db.query(`INSERT INTO agent_messages (thread_id, workspace_id, role, content, tool_calls) VALUES ($1, $2, 'assistant', $3, $4)`, [threadId, workspaceId, fullText, JSON.stringify(assistantToolCallsForHistory)]);
          messages.push({ role: 'assistant', content: fullText || null, tool_calls: assistantToolCallsForHistory });
          for (const tm of toolMessagesForGateway) messages.push(tm);
          fullText = '';
        }

        if (iteration >= 8 && (stopReason === 'tool_calls' || stopReason === 'tool_use')) {
          const capMsg = (fullText ? '\n\n' : '') + "I've done a lot in this turn — could you point me at the specific thing you want me to tackle next?";
          fullText += capMsg;
          write(sseEvent('assistant_delta', { text: capMsg }));
        }

        await ctx.db.query(`UPDATE agent_messages SET content = $1, token_usage = $2, created_at = now() WHERE id = $3`, [fullText, JSON.stringify(usage), assistantId]);
        await ctx.db.query(`UPDATE agent_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`, [threadId]);
        write(sseEvent('assistant_end', { message_id: assistantId, token_usage: usage }));
        write(sseEvent('done', {}));
      } catch (e: any) {
        console.error('[agent-chat] stream error:', e?.message ?? e, e?.stack);
        try { write(sseEvent('error', { code: 'internal', message: String(e?.message ?? e) })); write(sseEvent('done', {})); } catch {}
      } finally {
        await releaseLock();
        const recordBudget = async () => {
          try { if (usage?.total_tokens) await ctx.kv.incr(budgetKey, usage.total_tokens); } catch { /* swallow */ }
        };
        if (typeof ctx.waitUntil === 'function') ctx.waitUntil(recordBudget());
        else await recordBudget();
        try { controller.close(); } catch { /* already closed by cancel */ }
      }
    },
    cancel() {
      clientAbort.abort();
      const p = releaseLock();
      if (typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } });
}

