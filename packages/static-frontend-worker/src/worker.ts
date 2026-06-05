// Per-app static frontend worker.
//
// One copy of the compiled output of this file is uploaded into the WfP
// dispatch namespace per customer app (script name = appId). The worker is
// bound to a Cloudflare Assets binding containing the user's uploaded zip
// contents and serves them with an in-worker SPA fallback.
//
// SPA fallback: on a non-2xx from the Assets binding, retry against `/`
// (which resolves to the home `index.html` under
// `html_handling: 'auto-trailing-slash'`). This is the CF-canonical SPA
// pattern and is deterministic across CF runtime variants (we previously
// tried `not_found_handling: 'single-page-application'` and it threw inside
// WfP).
//
// We check `res.ok` (status 200-299) rather than `res.status !== 404`
// because the Assets binding inside a WfP dispatch namespace may return 307
// redirects for non-file paths (e.g. /people → 307 Location: /) instead of
// 404. Catching all non-2xx responses ensures SPA deep-links always resolve
// to the home document instead of producing unexpected redirects.
//
// IMPORTANT: the fallback fetches `/`, NOT `/index.html`. Under
// `html_handling: 'auto-trailing-slash'`, fetching `/index.html` itself
// returns a 307 redirect to `/` — the same trap this fallback exists to
// escape. Fetching `/` returns the home document with status 200 directly.
// Do not change this back to `/index.html`.
//
// MIME workaround: the Assets binding inside a WfP dispatch namespace does
// not reliably set Content-Type headers. Without a correct Content-Type,
// browsers block module scripts entirely ("strict MIME type checking"). We
// detect the type from the URL extension and override the header when it is
// missing. (The outer dispatch-worker also re-applies Content-Type at its
// layer — this in-worker copy is defensive belt-and-braces; cleanup tracked
// for a future PR.)

export interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
}

const MIME: Record<string, string> = {
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  wasm: 'application/wasm',
  xml: 'application/xml',
  txt: 'text/plain',
  map: 'application/json',
};

function withMime(req: Request, res: Response): Response {
  if (res.headers.get('content-type')) return res;
  // Extract extension from the last path segment only. Splitting the whole
  // URL on '.' picks up the hostname (e.g. '.butterbase.ai/geo' → 'ai/geo')
  // for extensionless paths. Extensionless paths are served by the Assets
  // binding from a .html file via html_handling, so default them to
  // text/html — octet-stream triggers a browser download instead of
  // rendering.
  const path = new URL(req.url).pathname;
  const filename = path.split('/').pop() || '';
  const dot = filename.lastIndexOf('.');
  const ext = dot > -1 ? filename.slice(dot + 1).toLowerCase() : '';
  const ct = MIME[ext] || (ext ? 'application/octet-stream' : 'text/html');
  const h = new Headers(res.headers);
  h.set('content-type', ct);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: h,
  });
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const res = await env.ASSETS.fetch(request);
      if (res.ok) return withMime(request, res);
      const url = new URL(request.url);
      url.pathname = '/';
      const fallback = await env.ASSETS.fetch(new Request(url.toString(), request));
      return withMime(new Request(url.toString()), fallback);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response('worker error: ' + message, { status: 500 });
    }
  },
};

export default handler;
