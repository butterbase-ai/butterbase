export async function handler(req, ctx) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405 });
  }
  let body;
  try { body = await req.json(); } catch { body = null; }
  const message = body && typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return new Response(JSON.stringify({ error: 'message required' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }

  const apiUrl = ctx.env.BUTTERBASE_API_URL;
  const appId = ctx.env.BUTTERBASE_APP_ID;
  const apiKey = ctx.env.BUTTERBASE_API_KEY;
  if (!apiUrl || !appId || !apiKey) {
    return new Response(JSON.stringify({ error: 'function env not configured' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  const base = `${apiUrl}/v1/${appId}/agents/support-overview/runs`;
  const auth = { Authorization: `Bearer ${apiKey}` };

  const startRes = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ input: { message } }),
  });
  if (!startRes.ok) {
    const t = await startRes.text().catch(() => '');
    return new Response(JSON.stringify({ error: `start ${startRes.status}: ${t.slice(0, 200)}` }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  const { run_id } = await startRes.json();

  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const pollRes = await fetch(`${base}/${run_id}`, { headers: auth });
    if (!pollRes.ok) {
      const t = await pollRes.text().catch(() => '');
      return new Response(JSON.stringify({ error: `poll ${pollRes.status}: ${t.slice(0, 200)}` }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
    const { run } = await pollRes.json();
    if (run.status === 'completed') {
      return new Response(JSON.stringify({ value: run.output?.value ?? '' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (run.status === 'failed' || run.status === 'errored') {
      return new Response(JSON.stringify({ error: run.error?.message || run.status }), { status: 502, headers: { 'content-type': 'application/json' } });
    }
  }
  return new Response(JSON.stringify({ error: 'timed out waiting for agent' }), { status: 504, headers: { 'content-type': 'application/json' } });
}
