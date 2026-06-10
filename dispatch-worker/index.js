// MIME workaround: the WfP dispatch layer can strip Content-Type headers set by
// the user worker. We re-apply them here at the outermost layer so the browser
// always receives the correct type. Without this, module scripts fail with
// "strict MIME type checking" errors and the page loads blank.
const MIME = {
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

function withMime(url, res) {
  if (res.headers.get('content-type')) return res;
  // Extract extension from the last path segment only. Splitting the whole URL
  // on '.' picks up the hostname (e.g. '.butterbase.ai/geo' → 'ai/geo') for
  // extensionless paths. Extensionless paths are served by the Assets binding
  // from a .html file via html_handling, so default them to text/html —
  // octet-stream triggers a browser download instead of rendering.
  const path = new URL(url).pathname;
  const filename = path.split('/').pop() || '';
  const dot = filename.lastIndexOf('.');
  const ext = dot > -1 ? filename.slice(dot + 1).toLowerCase() : '';
  const ct = MIME[ext] || (ext ? 'application/octet-stream' : 'text/html');
  const h = new Headers(res.headers);
  h.set('content-type', ct);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Parse a KV value into a {appId, region} route. Tolerates both new-format
// JSON values (written by Task 9) and legacy raw-string `appId` values
// (pre-Task 11 backfill); legacy values are assumed to live in the worker's
// local region.
export function parseKvValue(raw, env) {
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.appId) return { appId: parsed.appId, region: parsed.region ?? env.BUTTERBASE_REGION };
    } catch {
      // fall through
    }
  }
  return { appId: raw, region: env.BUTTERBASE_REGION };
}

// Route /_do/* to `${appId}_do`, /_containers/{name}/* to `${appId}_ctr_{name}`
// (one Worker per container — see docs/containers.md), everything else to the
// frontend script `appId`. Exported for tests.
export function resolveTargetScript(pathname, appId) {
  if (pathname.startsWith('/_do/')) {
    return { targetScript: `${appId}_do`, missingMessage: 'No Durable Objects deployed for this app.' };
  }
  const ctr = pathname.match(/^\/_containers\/([a-z][a-z0-9-]*)(\/|$)/);
  if (ctr) {
    return { targetScript: `${appId}_ctr_${ctr[1]}`, missingMessage: `No container "${ctr[1]}" deployed for this app.` };
  }
  return { targetScript: appId, missingMessage: 'App not deployed' };
}

export async function handleRequest(request, env) {
    const baseDomain = env.BASE_DOMAIN || 'butterbase.dev';

    // CF for SaaS (custom hostnames) rewrites the host header to a zone-local
    // subdomain (e.g. butterbase.kengoz.com → butterbase.butterbase.dev) for
    // internal routing, but preserves the original hostname in request.url.
    // Always derive the routing hostname from the URL so custom domain KV
    // lookups (domain:butterbase.kengoz.com) work correctly.
    const url = new URL(request.url);
    const hostname = url.hostname;

    // Redirect apex and www on the legacy butterbase.dev zone to butterbase.ai.
    // Customer apps still live on *.butterbase.dev subdomains, so only the
    // bare zone host and www get redirected.
    if (baseDomain === 'butterbase.dev' && (hostname === 'butterbase.dev' || hostname === 'www.butterbase.dev')) {
      return Response.redirect(`https://butterbase.ai${url.pathname}${url.search}`, 301);
    }

    let route;
    if (hostname.endsWith(`.${baseDomain}`) || hostname === baseDomain) {
      // Path 1: *.butterbase.dev subdomain routing
      const sub = hostname.split('.')[0];
      if (!sub || sub === 'www') {
        return new Response('Not found', { status: 404 });
      }
      const raw = await env.SUBDOMAINS.get(`sub:${sub}`);
      route = parseKvValue(raw, env);
      if (!route) {
        return new Response(`No app for subdomain "${sub}"`, { status: 404 });
      }
    } else {
      // Path 2: Custom domain routing (Cloudflare for SaaS)
      const raw = await env.SUBDOMAINS.get(`domain:${hostname}`);
      route = parseKvValue(raw, env);
      if (!route) {
        return new Response('Not found', { status: 404 });
      }
    }

    const { appId } = route;

    // Note: route.region is informational. The WfP dispatch namespace
    // (`bb-frontends`) is account-global, so the appId script is reachable
    // from this worker regardless of which Fly region originally provisioned
    // the app. A previous version emitted Fly-Replay here for cross-region
    // apps, but Cloudflare Workers cannot trigger Fly's region replay —
    // that header was a no-op that broke cross-region frontend serving.

    // Route /_do/* to the per-app DO worker (script `${appId}_do`); /_containers/{name}/*
    // to the per-container Worker (script `${appId}_ctr_{name}`); everything
    // else goes to the frontend worker (script `appId`). The DO and container scripts are
    // uploaded by control-api when the user registers their first Durable
    // Object or container, so apps without them simply won't have it — surface a clear 404
    // for that case.
    const { targetScript, missingMessage } = resolveTargetScript(url.pathname, appId);

    let worker;
    try {
      worker = env.DISPATCHER.get(targetScript);
    } catch (err) {
      if (targetScript !== appId) return new Response(missingMessage, { status: 404 });
      throw err;
    }

    try {
      const res = await worker.fetch(request);
      if (res.status === 101) return res;
      return withMime(request.url, res);
    } catch (err) {
      if (err.message?.includes('Worker not found')) {
        return new Response(missingMessage, { status: 404 });
      }
      throw err;
    }
}

export default { fetch: handleRequest };
