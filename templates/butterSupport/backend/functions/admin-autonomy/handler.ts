export async function handler(req, ctx) {
  if (!ctx.user) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    });
  }
  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  const { action, issue_type, mode } = body ?? {};
  if (typeof issue_type !== 'string' || !issue_type) {
    return new Response(JSON.stringify({ error: 'issue_type required' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  const VALID = ['draft_for_approval', 'auto_send', 'auto_resolve', 'force_escalate'];

  if (action === 'delete') {
    if (issue_type === 'default') {
      return new Response(JSON.stringify({ error: 'cannot delete default row' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    await ctx.db.query('DELETE FROM autonomy_settings WHERE issue_type = $1', [issue_type]);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  if (action === 'upsert') {
    if (!VALID.includes(mode)) {
      return new Response(JSON.stringify({ error: 'invalid mode' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }
    await ctx.db.query(
      `INSERT INTO autonomy_settings (issue_type, mode, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (issue_type)
       DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [issue_type, mode, ctx.user.id],
    );
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ error: 'action must be "upsert" or "delete"' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
}

