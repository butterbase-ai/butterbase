// Per-app static frontend worker.
//
// One copy of the compiled output of this file is uploaded into the WfP
// dispatch namespace per customer app (script name = appId). The worker is
// bound to a Cloudflare Assets binding containing the user's uploaded zip
// contents and serves them with an explicit path resolution chain.
//
// Path resolution (html_handling: 'none'):
//   The Assets binding returns literal file contents or 404 — no implicit CF
//   URL canonicalization or redirects in the loop. The worker explicitly tries
//   multiple path candidates in order:
//     1. Literal path (/foo.js, /styles.css, /index.html, etc.)
//     2. Trailing-slash directory index (/foo/ → /foo/index.html)
//     3. Extensionless → /path.html then /path/index.html
//   First 2xx wins. On all-miss, SPA fallback to / (which resolves via
//   candidate 2 above) — unless the request was for a binary/asset extension,
//   in which case an honest 404 is returned.
//
// MIME: the outer dispatch-worker re-applies Content-Type on every response.
// This worker returns raw Assets responses; there is no in-worker MIME map.

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

// Return the ordered list of asset paths to try for a given request path.
// With html_handling: 'none', Assets returns literal contents or 404 — no
// redirects. The worker tries these candidates in order; first 2xx wins.
function resolveAssetPath(path: string): string[] {
  const candidates: string[] = [];

  // 1. Literal path (handles /foo.js, /styles.css, /index.html, etc.)
  candidates.push(path);

  // 2. Trailing-slash directory index (/foo/ → /foo/index.html)
  if (path.endsWith('/')) {
    candidates.push(path + 'index.html');
    return candidates;
  }

  // 3. Extensionless → try .html and /index.html
  const filename = path.split('/').pop() || '';
  if (!filename.includes('.')) {
    candidates.push(path + '.html');
    candidates.push(path + '/index.html');
  }

  return candidates;
}

// Routes that look like "I'm a page" — fall back to SPA index on miss.
// Routes that look like assets (.png/.js/etc.) get an honest 404.
function isRouteLikeRequest(path: string): boolean {
  const filename = path.split('/').pop() || '';
  if (!filename.includes('.')) return true; // /history, /profile
  return /\.(html?)$/i.test(filename); // /about.html
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

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const rules = loadRules(env);
      const match = rules.length > 0 ? findMatch(url.pathname, rules) : null;

      // Cloudflare Pages-compatible precedence:
      //   1. 3xx redirect rules ALWAYS win, even if the path is a real file.
      //   2. Real assets win over 200 rewrites — try the asset binding first.
      //   3. 200 rewrites apply only after the asset lookup misses.
      //   4. No rule + asset miss → SPA fallback to `/` for route-shaped paths.
      //   5. Asset-shaped paths (extension != .html/.htm) return honest 404.

      // (1) 3xx redirects: fire unconditionally.
      if (match && match.rule.status >= 300 && match.rule.status < 400) {
        return Response.redirect(
          new URL(match.resolvedTo, url).toString(),
          match.rule.status,
        );
      }

      // (2) Asset lookup: try each candidate in order, first 2xx wins.
      // Real files win over 200 rewrites (matches Cloudflare Pages behavior).
      const candidates = resolveAssetPath(url.pathname);
      let lastAssetRes: Response | null = null;
      for (const candidate of candidates) {
        const candidateUrl = new URL(request.url);
        candidateUrl.pathname = candidate;
        const res = await env.ASSETS.fetch(new Request(candidateUrl.toString(), request));
        if (res.ok) return res;
        lastAssetRes = res;
      }

      // (3) Asset miss + 200 rewrite matched → try rewrite target candidates.
      if (match && match.rule.status === 200) {
        const targetCandidates = resolveAssetPath(match.resolvedTo);
        for (const candidate of targetCandidates) {
          const candidateUrl = new URL(request.url);
          candidateUrl.pathname = candidate;
          const rewritten = await env.ASSETS.fetch(
            new Request(candidateUrl.toString(), request),
          );
          if (rewritten.ok) return rewritten;
        }
      }

      // (4 & 5) All candidates missed. Route-shaped paths get SPA fallback;
      // asset-shaped paths (binary extensions) return an honest 404.
      if (isRouteLikeRequest(url.pathname)) {
        // SPA fallback: fetch /index.html directly. Under html_handling: 'none',
        // '/' always 404s (no literal file named '/'); skipping it saves a
        // guaranteed-miss round-trip on every SPA miss.
        const spaUrl = new URL(request.url);
        spaUrl.pathname = '/index.html';
        const fallback = await env.ASSETS.fetch(new Request(spaUrl.toString(), request));
        if (fallback.ok) return fallback;
        lastAssetRes = fallback;
        // If /index.html also misses, return the last response as-is.
        return lastAssetRes ?? new Response('', { status: 404 });
      }

      // Asset-shaped miss: return the last 404 verbatim. No SPA fallback.
      return lastAssetRes ?? new Response('', { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response('worker error: ' + message, { status: 500 });
    }
  },
};

export default handler;
