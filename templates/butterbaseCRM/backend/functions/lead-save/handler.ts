// backend/functions/lead-save/handler.ts
//
// Saves Lead Finder search picks into:
//   1. Substrate person/company entities (CRM graph)
//   2. A SQL `campaign_lists` row + `campaign_list_members` (so the list shows
//      up in Campaigns alongside lists from elsewhere in the app)
//
// "Lead lists" and "campaign lists" are the same concept — both live in
// campaign_lists, filtered by entity_type='people'.

const cacheKey = (h) => `leadcache:${h}`;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function extractEntityId(verdict) {
  if (!verdict) return null;
  return verdict.result?.entity_id ?? verdict.entity_id ?? verdict.id ?? verdict.result?.id ?? null;
}

export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });
  if (!ctx.substrate) return json(503, { error: 'substrate_not_linked' });

  let body;
  try { body = await req.json(); } catch { body = {}; }

  const workspaceId = String(body?.workspace_id ?? '');
  const queryHash = String(body?.query_hash ?? '');
  const selected = Array.isArray(body?.result_ids) ? body.result_ids.filter((s) => typeof s === 'string') : [];
  const reveal = !!body?.reveal_emails;
  const target =
    body?.target === 'all_people' || body?.target === 'existing' || body?.target === 'new' ? body.target : 'new';
  const listIdInput = typeof body?.list_id === 'string' ? body.list_id : undefined;
  const newListName = typeof body?.new_list_name === 'string' ? body.new_list_name : undefined;

  if (!workspaceId) return json(400, { error: 'workspace_id_required' });
  if (!queryHash) return json(400, { error: 'query_hash_required' });
  if (selected.length === 0) return json(400, { error: 'no_results_selected' });
  if (target === 'existing' && !listIdInput) return json(400, { error: 'list_id_required' });
  if (target === 'new' && !newListName) return json(400, { error: 'new_list_name_required' });

  // Workspace membership check — matches create-campaign-list pattern.
  const m = await ctx.db.query(
    'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1',
    [workspaceId, ctx.user.id],
  );
  if (m.rows.length === 0) return json(403, { error: 'not_a_member' });

  // Pull cached results from KV
  const blob = await ctx.kv.get(cacheKey(queryHash));
  if (!blob || blob.query_hash !== queryHash) {
    return json(410, { error: 'cache_expired', detail: 'Re-run the search before saving' });
  }
  const cached = Array.isArray(blob.results) ? blob.results : [];
  const byId = new Map(cached.map((r) => [r.external_id, r]));
  const picks = selected.map((id) => byId.get(id)).filter((p) => !!p);
  if (picks.length === 0) return json(400, { error: 'selected_ids_not_in_cache' });

  // Resolve target list (campaign_lists row) — or null for "all_people"
  let listId = null;
  let listRow = null;
  if (target === 'existing') {
    const res = await ctx.db.query(
      `SELECT id, workspace_id, entity_type FROM campaign_lists WHERE id = $1 LIMIT 1`,
      [listIdInput],
    );
    if (res.rows.length === 0) return json(404, { error: 'list_not_found' });
    const row = res.rows[0];
    if (row.workspace_id !== workspaceId) return json(403, { error: 'list_wrong_workspace' });
    if (row.entity_type !== 'people') return json(400, { error: 'list_wrong_entity_type', detail: 'Target list is not a people list' });
    listId = row.id;
    listRow = row;
  } else if (target === 'new') {
    const ins = await ctx.db.query(
      `INSERT INTO campaign_lists (workspace_id, name, entity_type, source, source_spec, created_by, member_count)
       VALUES ($1, $2, 'people', 'ai_search', $3, $4, 0)
       RETURNING *`,
      [workspaceId, newListName.trim(), JSON.stringify({ query_hash: queryHash }), ctx.user.id],
    );
    listRow = ins.rows[0];
    listId = listRow.id;
  }

  async function queueEmailLookup(linkedinUrl) {
    try {
      const res = await fetch(
        `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/people/profile/email`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}` },
          body: JSON.stringify({ linkedinProfileUrl: linkedinUrl }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const text = await res.text();
      console.log(`[queue] linkedin=${linkedinUrl} http=${res.status} body=${text.slice(0, 300)}`);
      if (!res.ok) return { lookupId: null, error: `${res.status}:${text.slice(0, 100)}` };
      const j = JSON.parse(text);
      return { lookupId: j?.lookupId ?? null };
    } catch (e) {
      console.log(`[queue] linkedin=${linkedinUrl} fetch_error=${e?.message}`);
      return { lookupId: null, error: String(e?.message ?? e).slice(0, 100) };
    }
  }

  console.log(`[lead-save] picks=${picks.length} reveal=${reveal}`);

  // Fan out all per-lead work concurrently — one slow provider call
  // shouldn't serialise the whole batch into a function timeout.
  const results = await Promise.allSettled(
    picks.map(async (pick) => {
    let companyId = null;
    if (pick.company_name) {
      const companyKeys = pick.company_domain ? { domain: pick.company_domain } : { name: pick.company_name };
      const cVerdict = await ctx.substrate.propose('upsert_entity', {
        type: 'company',
        display_name: pick.company_name,
        canonical_keys: companyKeys,
        attrs: {
          name: pick.company_name,
          domain: pick.company_domain ?? null,
          source: 'lead_finder',
        },
      });
      companyId = extractEntityId(cVerdict);
    }

    const personAttrs = {
      first_name: pick.first_name ?? null,
      last_name: pick.last_name ?? null,
      title: pick.title ?? null,
      linkedin_url: pick.linkedin_url ?? null,
      location: pick.location ?? null,
      company_id: companyId,
      company_name: pick.company_name ?? null,
      source: 'lead_finder',
    };

    let queuedOk = false;
    if (reveal && pick.linkedin_url) {
      const queued = await queueEmailLookup(pick.linkedin_url);
      if (queued.lookupId) {
        personAttrs.email = null;
        personAttrs.email_status = 'pending';
        personAttrs.email_lookup_id = queued.lookupId;
        personAttrs.email_lookup_queued_at = new Date().toISOString();
        queuedOk = true;
      } else {
        personAttrs.email = null;
        personAttrs.email_status = 'unknown';
        personAttrs.email_lookup_error = queued.error ?? 'unknown';
      }
    } else if (reveal) {
      personAttrs.email = null;
      personAttrs.email_status = 'unknown';
    }

    const pVerdict = await ctx.substrate.propose('upsert_entity', {
      type: 'person',
      display_name: pick.full_name,
      canonical_keys: { linkedin_url: pick.linkedin_url ?? pick.external_id },
      attrs: personAttrs,
    });
    const personId = extractEntityId(pVerdict);
    return { pick, personId, email: personAttrs.email ?? null, queuedOk };
    }),
  );

  const saved = results
    .filter((r) => r.status === 'fulfilled' && r.value?.personId)
    .map((r) => r.value);

  // Count only leads whose lookup was actually accepted by the provider —
  // a failed queue (e.g. 402 insufficient_credits) is not "pending".
  const pendingEmail = saved.filter((s) => s.queuedOk).length;

  if (listId && saved.length > 0) {
    const values = [];
    const params = [];
    let p = 1;
    for (const s of saved) {
      values.push(`($${p++}, $${p++}, 'people', $${p++}, $${p++}, $${p++}, $${p++})`);
      const vars = {
        first_name: s.pick.first_name ?? null,
        last_name: s.pick.last_name ?? null,
        title: s.pick.title ?? null,
        company_name: s.pick.company_name ?? null,
      };
      params.push(workspaceId, listId, s.personId, s.email, JSON.stringify(vars), ctx.user.id);
    }
    await ctx.db.query(
      `INSERT INTO campaign_list_members (workspace_id, list_id, entity_type, entity_id, email_snapshot, vars_snapshot, added_by)
       VALUES ${values.join(', ')}
       ON CONFLICT (list_id, entity_type, entity_id) DO NOTHING`,
      params,
    );

    await ctx.db.query(
      `UPDATE campaign_lists
       SET member_count = (SELECT COUNT(*) FROM campaign_list_members WHERE list_id = $1),
           updated_at = now()
       WHERE id = $1`,
      [listId],
    );
  }

  return json(200, {
    saved_count: saved.length,
    list_id: listId,
    list: listRow,
    person_ids: saved.map((s) => s.personId),
    pending_email_count: pendingEmail,
    revealed_email_count: 0,
  });
}

