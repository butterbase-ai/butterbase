// bb-placeholder/index.js
// Shared placeholder worker deployed once into the `bb-frontends` dispatch
// namespace under the sentinel script name `__placeholder__`. The dispatch
// worker routes new apps here until the user deploys a real frontend, at
// which point the control-api rewrites `sub:{subdomain}` in KV to point at
// the real user-script.
//
// Host-derived subdomain is the only per-app signal available in-worker;
// the app_id is NOT known here. The "Your API" sample shows a placeholder
// token — the page is advisory.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function render(subdomain) {
  const safeSubdomain = escapeHtml(subdomain);
  const appName = safeSubdomain; // we don't know the friendly name in-worker
  const apiUrl = `https://${safeSubdomain}.butterbase.dev/v1/&lt;your-app-id&gt;`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appName} — Powered by Butterbase</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --accent: #f59e0b; --card: #fff; --border: #e7e5e4; --code-bg: #f5f5f4; }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #1c1917; --fg: #fafaf9; --muted: #a8a29e; --card: #292524; --border: #44403c; --code-bg: #292524; }
    }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 3rem 1.5rem; }
    .container { max-width: 640px; width: 100%; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 0.25rem; }
    .badge { display: inline-flex; align-items: center; gap: 0.375rem; font-size: 0.8rem; color: var(--muted); margin-bottom: 2rem; }
    .badge a { color: var(--accent); text-decoration: none; font-weight: 600; }
    .badge a:hover { text-decoration: underline; }
    .section { background: var(--card); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 1.25rem; }
    .section h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 0.75rem; }
    .api-url { display: flex; align-items: center; gap: 0.5rem; }
    .api-url code { flex: 1; background: var(--code-bg); padding: 0.5rem 0.75rem; border-radius: 0.375rem; font-size: 0.85rem; word-break: break-all; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; }
    pre { background: var(--code-bg); padding: 1rem; border-radius: 0.375rem; overflow-x: auto; font-size: 0.8rem; line-height: 1.6; font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace; }
    .steps { list-style: none; }
    .steps li { padding: 0.5rem 0; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
    .steps li:last-child { border-bottom: none; }
    .steps li::before { content: attr(data-step); display: inline-block; width: 1.5rem; height: 1.5rem; line-height: 1.5rem; text-align: center; background: var(--accent); color: #1c1917; border-radius: 50%; font-size: 0.7rem; font-weight: 700; margin-right: 0.625rem; }
    .footer { margin-top: 2rem; text-align: center; font-size: 0.8rem; color: var(--muted); }
  </style>
</head>
<body>
  <div class="container">
    <h1>${appName}</h1>
    <div class="badge">Powered by <a href="https://butterbase.ai" target="_blank">Butterbase</a></div>

    <div class="section">
      <h2>Your API</h2>
      <div class="api-url">
        <code>${apiUrl}</code>
      </div>
    </div>

    <div class="section">
      <h2>Quick Start</h2>
      <pre><code>// Fetch data from your app
const res = await fetch('${apiUrl}/your_table');
const data = await res.json();
console.log(data);</code></pre>
    </div>

    <div class="section">
      <h2>Next Steps</h2>
      <ul class="steps">
        <li data-step="1">Define your database schema</li>
        <li data-step="2">Set up authentication</li>
        <li data-step="3">Deploy your frontend to replace this page</li>
      </ul>
    </div>

    <p class="footer">This is a placeholder page. Deploy your own frontend to replace it.</p>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request) {
    const host = request.headers.get('host') || '';
    const subdomain = host.split('.')[0] || 'your-app';
    return new Response(render(subdomain), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=60',
      },
    });
  },
};
