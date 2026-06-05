import { describe, it, expect } from 'vitest';
import worker, { type Env } from './worker.js';

/**
 * Build an env.ASSETS mock with configurable per-path responses. Recorded
 * fetch paths are exposed for assertions.
 */
function makeAssetsEnv(
  routes: Record<string, () => Response>,
  defaultStatus = 404,
  rulesJson?: string,
): { env: Env; calls: string[] } {
  const calls: string[] = [];
  const env: Env = {
    ASSETS: {
      async fetch(req: Request): Promise<Response> {
        const path = new URL(req.url).pathname;
        calls.push(path);
        const route = routes[path];
        if (route) return route();
        return new Response('', { status: defaultStatus });
      },
    },
    BB_REDIRECTS_RULES: rulesJson,
  };
  return { env, calls };
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

// Build a Response that DOES NOT have an inferred content-type. Node's
// Response constructor auto-sets `text/plain;charset=UTF-8` for string
// bodies, which doesn't match the CF runtime (where `new Response(body)`
// leaves content-type unset). Using a byte body sidesteps that inference so
// the worker's withMime fallback can be exercised faithfully.
function bytesResponseNoContentType(body: string, status = 200): Response {
  return new Response(new TextEncoder().encode(body), { status });
}

function redirectResponse(location: string, status = 307): Response {
  return new Response('', { status, headers: { location } });
}

const INDEX_BODY = '<!doctype html><html><body><div id="root"></div></body></html>';

describe('static-frontend-worker', () => {
  describe('happy path', () => {
    it('serves a hit asset directly without entering the fallback branch', async () => {
      const { env, calls } = makeAssetsEnv({
        '/assets/app.css': () =>
          new Response('body { color: red; }', {
            status: 200,
            headers: { 'content-type': 'text/css' },
          }),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/assets/app.css'),
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/css');
      expect(await res.text()).toBe('body { color: red; }');
      expect(calls).toEqual(['/assets/app.css']);
    });

    it('serves the root path directly with status 200', async () => {
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      expect(calls).toEqual(['/']);
    });
  });

  describe('SPA fallback (the PR #33 fix)', () => {
    it('resolves a deep-path miss (307 → /) to the home document with status 200', async () => {
      // Real CF behavior under `html_handling: 'auto-trailing-slash'`:
      //   - extensionless misses 307 to `/`
      //   - `/index.html` ALSO 307s to `/` (the trap)
      //   - `/` serves index.html with 200
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
        '/index.html': () => redirectResponse('/'),
        '/history': () => redirectResponse('/'),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      // Regression guard: the fallback must hit `/`, not `/index.html`.
      expect(calls).toEqual(['/history', '/']);
      expect(calls).not.toContain('/index.html');
    });

    it('resolves a 404 miss to the home document', async () => {
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
      });
      // No /unknown route → default 404 from the mock
      const res = await worker.fetch(
        new Request('https://app.example.com/unknown'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      expect(calls).toEqual(['/unknown', '/']);
    });

    it('preserves the fallback response status when the home document is also missing', async () => {
      // Pathological app with no index.html: both first hop and fallback miss.
      const { env, calls } = makeAssetsEnv({}, 404);
      const res = await worker.fetch(
        new Request('https://app.example.com/missing'),
        env,
      );
      // Fallback returns whatever / returns. Both 404 → status 404.
      expect(res.status).toBe(404);
      expect(calls).toEqual(['/missing', '/']);
    });
  });

  describe('MIME defaults', () => {
    it('applies text/css when the assets binding returns a .css file with no content-type', async () => {
      const { env } = makeAssetsEnv({
        '/styles.css': () => bytesResponseNoContentType('body{}'),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/styles.css'),
        env,
      );
      expect(res.headers.get('content-type')).toBe('text/css');
    });

    it('applies application/javascript for .mjs', async () => {
      const { env } = makeAssetsEnv({
        '/app.mjs': () => bytesResponseNoContentType('export const x = 1;'),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/app.mjs'),
        env,
      );
      expect(res.headers.get('content-type')).toBe('application/javascript');
    });

    it('defaults to text/html for extensionless paths', async () => {
      // Extensionless paths are served by the Assets binding from a .html
      // file via html_handling. Mark them text/html so the browser renders
      // them instead of triggering a download.
      const { env } = makeAssetsEnv({
        '/geo': () => bytesResponseNoContentType('<h1>geo</h1>'),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/geo'),
        env,
      );
      expect(res.headers.get('content-type')).toBe('text/html');
    });

    it('does NOT mis-detect the hostname dot as the extension for extensionless paths', async () => {
      // Regression for the bug fixed in 0524fd9c: splitting the whole URL on
      // '.' picks up 'ai' as the "extension" of 'butterbase.ai/geo' and
      // falls through to application/octet-stream (triggering a download).
      const { env } = makeAssetsEnv({
        '/geo': () => bytesResponseNoContentType('<h1>geo</h1>'),
      });
      const res = await worker.fetch(
        new Request('https://app.butterbase.ai/geo'),
        env,
      );
      expect(res.headers.get('content-type')).toBe('text/html');
      expect(res.headers.get('content-type')).not.toBe('application/octet-stream');
    });

    it('defaults to application/octet-stream for unknown extensions', async () => {
      const { env } = makeAssetsEnv({
        '/data.bin': () => bytesResponseNoContentType('binary'),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/data.bin'),
        env,
      );
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
    });

    it('preserves a content-type the assets binding already set', async () => {
      const { env } = makeAssetsEnv({
        '/styles.css': () =>
          new Response('body{}', {
            status: 200,
            headers: { 'content-type': 'text/css; charset=utf-8' },
          }),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/styles.css'),
        env,
      );
      expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    });
  });

  describe('binary asset round-trip', () => {
    it('passes binary bytes through unchanged', async () => {
      const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const { env } = makeAssetsEnv({
        '/logo.png': () =>
          new Response(pngHeader, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/logo.png'),
        env,
      );
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bytes)).toEqual(Array.from(pngHeader));
    });
  });

  describe('error handling', () => {
    it('returns a 500 with a readable body when env.ASSETS throws', async () => {
      const env: Env = {
        ASSETS: {
          async fetch(): Promise<Response> {
            throw new Error('asset binding exploded');
          },
        },
      };
      const res = await worker.fetch(
        new Request('https://app.example.com/whatever'),
        env,
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('worker error: asset binding exploded');
    });

    it('returns a 500 when env.ASSETS throws a non-Error value', async () => {
      const env: Env = {
        ASSETS: {
          async fetch(): Promise<Response> {
            throw 'string-thrown';
          },
        },
      };
      const res = await worker.fetch(
        new Request('https://app.example.com/whatever'),
        env,
      );
      expect(res.status).toBe(500);
      expect(await res.text()).toBe('worker error: string-thrown');
    });
  });

  describe('_redirects rule application (BB_REDIRECTS_RULES binding)', () => {
    it('applies a 200 rewrite rule (serves target content under the original URL)', async () => {
      const indexBody = '<html>HOME</html>';
      const { env, calls } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody) },
        404,
        JSON.stringify([{ from: '/*', to: '/index.html', status: 200 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(indexBody);
      // The rewrite target /index.html is special-cased to fetch / instead
      // (to escape the html_handling 307 trap). No call to /history.
      expect(calls).toEqual(['/']);
    });

    it('applies a 301 redirect rule (returns Location header, does NOT fetch target)', async () => {
      const { env, calls } = makeAssetsEnv(
        { '/new': () => htmlResponse('<html>new</html>') },
        404,
        JSON.stringify([{ from: '/old', to: '/new', status: 301 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/old'),
        env,
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://app.example.com/new');
      // A redirect must NOT fetch the target — that's the client's job.
      expect(calls).toEqual([]);
    });

    it('first match wins (preserves rule order)', async () => {
      const indexBody = '<html>HOME</html>';
      const aboutBody = '<html>ABOUT</html>';
      const { env } = makeAssetsEnv(
        {
          '/': () => htmlResponse(indexBody),
          '/about.html': () => htmlResponse(aboutBody),
        },
        404,
        JSON.stringify([
          { from: '/about', to: '/about.html', status: 200 },
          { from: '/*', to: '/index.html', status: 200 },
        ]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/about'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(aboutBody);
    });

    it('substitutes :splat in the rewrite target', async () => {
      const { env, calls } = makeAssetsEnv(
        { '/v2/users/42': () => htmlResponse('<html>v2</html>') },
        404,
        JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 200 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/api/users/42'),
        env,
      );
      expect(res.status).toBe(200);
      expect(calls).toEqual(['/v2/users/42']);
    });

    it('substitutes :splat in the redirect target', async () => {
      const { env } = makeAssetsEnv(
        {},
        404,
        JSON.stringify([{ from: '/old/*', to: '/new/:splat', status: 301 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/old/users/42'),
        env,
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://app.example.com/new/users/42');
    });

    it.each([301, 302, 303, 307, 308])('honors redirect status %i', async (status) => {
      const { env } = makeAssetsEnv(
        {},
        404,
        JSON.stringify([{ from: '/a', to: '/b', status }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/a'),
        env,
      );
      expect(res.status).toBe(status);
    });

    it('falls through to default asset lookup + SPA fallback when no rule matches', async () => {
      const indexBody = '<html>HOME</html>';
      const { env, calls } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody) },
        404,
        JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 301 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/unrelated/deep/path'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(indexBody);
      // First hop: /unrelated/deep/path → 404. Fallback: /. SPA fallback path
      // is preserved for apps without a `/*` catch-all rule.
      expect(calls).toEqual(['/unrelated/deep/path', '/']);
    });

    it('treats absent BB_REDIRECTS_RULES as no rules (existing behavior unchanged)', async () => {
      const indexBody = '<html>HOME</html>';
      const { env, calls } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody) },
        404,
        // no rulesJson argument
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(calls).toEqual(['/history', '/']);
    });

    it('treats malformed BB_REDIRECTS_RULES JSON as no rules (does not break serving)', async () => {
      const indexBody = '<html>HOME</html>';
      const { env } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody) },
        404,
        '{not valid json',
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(indexBody);
    });

    it('discards rule entries with wrong shape and serves with remaining valid rules', async () => {
      const { env } = makeAssetsEnv(
        { '/v2/foo': () => htmlResponse('<html>v2</html>') },
        404,
        JSON.stringify([
          { from: 123, to: '/bad', status: 200 }, // wrong type — filtered
          { from: '/foo', to: '/v2/foo', status: 200 },
        ]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/foo'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<html>v2</html>');
    });
  });
});
