// Internal proxy: forwards a chat-completions body to the platform AI gateway.
// Exists because the /chat/completions route rejects BUTTERBASE_INTERNAL_FN_KEY
// (which is what DO code uses), so DOs invoke this wrapper instead.
//
// Bearer: AI_GATEWAY_KEY (an app-scoped bb_sk_* with ai:gateway scope). Named
// with an un-reserved prefix because manage_function update_env now rejects
// BUTTERBASE_*-prefixed keys as reserved. Set this via update_env after deploy.

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req, ctx) {
  const ct = ctx.caller?.type;
  if (ct !== 'loopback' && ct !== 'service_key') {
    return json({ error: 'forbidden', caller_type: ct || null }, 403);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!body?.model || !Array.isArray(body?.messages)) {
    return json({ error: 'missing_model_or_messages' }, 400);
  }

  const res = await fetch(
    `${ctx.env.BUTTERBASE_API_URL}/v1/${ctx.env.BUTTERBASE_APP_ID}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.env.BUTTERBASE_API_KEY}`,
      },
      body: JSON.stringify(body),
    },
  );

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' },
  });
}
