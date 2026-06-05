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
  /**
   * Compiled `_redirects` rules, JSON-encoded. Populated by control-api at
   * deploy time from the user's `dist/_redirects` file (if shipped). When
   * unset/empty, the worker behaves as before: direct asset lookup with
   * SPA fallback to `/`.
   *
   * Format: `[{from, to, status}, ...]` matching RedirectRule from
   * ./redirects-parser.ts. Rules are applied in order; first match wins.
   * Status 200 = rewrite (serve target's content under the original URL),
   * 3xx = redirect (return Location header). Parsing happens at deploy
   * time so the runtime is minimal — see redirects-parser.ts.
   */
  BB_REDIRECTS_RULES?: string;
}

interface RedirectRule {
  from: string;
  to: string;
  status: number;
}

// Cache the parsed rules across invocations within an isolate. The binding is
// a plain_text string baked at deploy time; it cannot change within a
// running worker, so reparsing per request would be wasted CPU.
let cachedRules: RedirectRule[] | null = null;
let cachedRulesSource: string | undefined;

function loadRules(env: Env): RedirectRule[] {
  const source = env.BB_REDIRECTS_RULES;
  if (source === cachedRulesSource && cachedRules !== null) return cachedRules;
  cachedRulesSource = source;
  if (!source) {
    cachedRules = [];
    return cachedRules;
  }
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) {
      cachedRules = parsed.filter(
        (r: unknown): r is RedirectRule =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as RedirectRule).from === 'string' &&
          typeof (r as RedirectRule).to === 'string' &&
          typeof (r as RedirectRule).status === 'number',
      );
      return cachedRules;
    }
  } catch {
    // Fall through. A malformed binding should not break asset serving;
    // the worker continues without rules.
  }
  cachedRules = [];
  return cachedRules;
}

function matchRule(path: string, rule: RedirectRule): string | null {
  if (rule.from.endsWith('/*')) {
    const prefix = rule.from.slice(0, -2);
    if (path === prefix || path.startsWith(prefix + '/') || prefix === '') {
      let splat: string;
      if (prefix === '') {
        splat = path.replace(/^\/+/, '');
      } else if (path === prefix) {
        splat = '';
      } else {
        splat = path.slice(prefix.length + 1);
      }
      return rule.to.replace(/:splat/g, splat);
    }
    return null;
  }
  return path === rule.from ? rule.to : null;
}

function findMatch(
  path: string,
  rules: RedirectRule[],
): { rule: RedirectRule; resolvedTo: string } | null {
  for (const rule of rules) {
    const resolvedTo = matchRule(path, rule);
    if (resolvedTo !== null) return { rule, resolvedTo };
  }
  return null;
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
      const url = new URL(request.url);
      const rules = loadRules(env);

      // Apply _redirects rules BEFORE the asset lookup. First match wins.
      // Status 200 = internal rewrite (fetch the target, return its content
      // under the original URL). 3xx = client-visible redirect.
      if (rules.length > 0) {
        const match = findMatch(url.pathname, rules);
        if (match) {
          const target = match.resolvedTo;
          if (match.rule.status >= 300 && match.rule.status < 400) {
            return Response.redirect(
              new URL(target, url).toString(),
              match.rule.status,
            );
          }
          // 200 rewrite: fetch target from assets under the original URL.
          // Special case: a rewrite to `/index.html` retargets to `/` because
          // `html_handling: 'auto-trailing-slash'` returns a 307 → / for
          // `/index.html` itself, which would defeat the rewrite. Fetching
          // `/` serves the same content via the trailing-slash resolution.
          const fetchPath = target === '/index.html' ? '/' : target;
          const fetchUrl = new URL(fetchPath, url);
          const rewritten = await env.ASSETS.fetch(
            new Request(fetchUrl.toString(), request),
          );
          return withMime(new Request(fetchUrl.toString()), rewritten);
        }
      }

      // No matching rule (or no rules at all) → original behavior: direct
      // asset lookup, with SPA fallback to `/` on non-2xx. This preserves the
      // PR #33 fix for apps that don't ship a `_redirects` file.
      const res = await env.ASSETS.fetch(request);
      if (res.ok) return withMime(request, res);
      const fallbackUrl = new URL(request.url);
      fallbackUrl.pathname = '/';
      const fallback = await env.ASSETS.fetch(
        new Request(fallbackUrl.toString(), request),
      );
      return withMime(new Request(fallbackUrl.toString()), fallback);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response('worker error: ' + message, { status: 500 });
    }
  },
};

export default handler;
