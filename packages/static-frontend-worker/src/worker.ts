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

// Translate a rewrite target to the form Assets actually serves with 200 under
// `html_handling: 'auto-trailing-slash'`. The Assets binding 307-redirects any
// .html path to its canonical extensionless form; if a rewrite asks for
// /foo.html and we forward Assets's 307, the rewrite is broken (client sees
// the 307). Normalizing here means the worker fetches the form Assets returns
// 200 for, and we serve that content under the original request URL.
function normalizeRewriteTarget(target: string): string {
  // Don't rewrite cross-origin targets (e.g. external URLs that snuck into a
  // 200 rule — though those are nonsensical, defend in depth).
  if (/^https?:\/\//i.test(target)) return target;
  if (target.endsWith('/index.html')) {
    // /foo/index.html → /foo/   ;   /index.html → /
    return target.slice(0, -'index.html'.length);
  }
  if (target.endsWith('.html')) {
    return target.slice(0, -'.html'.length);
  }
  return target;
}

// Decide whether an Assets binding response represents a "miss" (no file at
// the requested path) vs a hit. Hits include both literal 2xx responses AND
// canonical 3xx redirects that `html_handling: 'auto-trailing-slash'` issues
// for existing .html / index.html files:
//
//   /foo.html        → 307 Location: /foo            (canonical, asset exists)
//   /foo/index.html  → 307 Location: /foo/           (canonical, asset exists)
//   /index.html      → 307 Location: /               (canonical, asset exists)
//   /missing.html    → 404                            (true miss)
//   /missing         → 307 Location: /   (WfP only)   (miss-fallback)
//
// We distinguish hit-vs-miss for 3xx responses by comparing the actual
// Location header to the expected canonical form of the requested path. Any
// 3xx whose Location does NOT match the canonical form is a miss-fallback
// (the WfP dispatch-namespace quirk PR #33 worked around).
function looksLikeAssetMiss(res: Response, requestPath: string): boolean {
  if (res.status === 404) return true;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    let expectedCanonical: string | null = null;
    if (requestPath.endsWith('/index.html')) {
      expectedCanonical = requestPath.slice(0, -'index.html'.length);
    } else if (requestPath.endsWith('.html')) {
      expectedCanonical = requestPath.slice(0, -'.html'.length);
    }
    if (expectedCanonical !== null && loc === expectedCanonical) {
      return false; // canonical redirect = asset exists
    }
    return true; // miss-fallback redirect
  }
  return false; // 2xx — asset hit
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
      const match = rules.length > 0 ? findMatch(url.pathname, rules) : null;

      // Cloudflare Pages-compatible precedence:
      //   1. 3xx redirect rules ALWAYS win, even if the path is a real file.
      //      (`/old /new 301` fires even when /old exists.)
      //   2. Real assets win over 200 rewrites — try the asset binding next.
      //      A 200 rewrite is a fallback that only fires on asset miss.
      //   3. 200 rewrites apply only after the asset lookup misses.
      //   4. No rule + asset miss → preserve PR #33 SPA fallback to `/`
      //      (this is the default behavior for apps that don't ship a
      //      _redirects file; keeping it ensures purely-additive semantics).

      // (1) 3xx redirects: fire unconditionally.
      if (match && match.rule.status >= 300 && match.rule.status < 400) {
        return Response.redirect(
          new URL(match.resolvedTo, url).toString(),
          match.rule.status,
        );
      }

      // (2) Asset lookup. If the asset exists, serve it — real files win
      // over 200 rewrites (matches Cloudflare Pages behavior). "Exists"
      // includes canonical 3xx redirects that html_handling issues for
      // existing .html / index.html files; those are forwarded so the
      // browser sees the canonical URL (the documented CF Pages behavior).
      const res = await env.ASSETS.fetch(request);
      if (!looksLikeAssetMiss(res, url.pathname)) return withMime(request, res);

      // (3) Asset miss + 200 rewrite matched → apply rewrite.
      // `html_handling: 'auto-trailing-slash'` canonicalizes any .html path
      // away: /foo.html → 307 /foo, /foo/index.html → 307 /foo/, /index.html
      // → 307 /. Fetching the .html target literally would defeat the
      // rewrite (the worker would forward the 307). normalizeRewriteTarget
      // strips .html / index.html so the resolved path round-trips through
      // Assets's trailing-slash resolution and returns 200.
      if (match && match.rule.status === 200) {
        const fetchPath = normalizeRewriteTarget(match.resolvedTo);
        const fetchUrl = new URL(fetchPath, url);
        const rewritten = await env.ASSETS.fetch(
          new Request(fetchUrl.toString(), request),
        );
        return withMime(new Request(fetchUrl.toString()), rewritten);
      }

      // (4) No matching rule and asset miss → default SPA fallback to `/`.
      // Preserves the PR #33 fix for apps that don't ship a `_redirects`
      // file (and for apps that ship one without a catch-all).
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
