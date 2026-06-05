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

    it('serves the root path directly with status 200 via index.html candidate', async () => {
      // / is a trailing-slash path — candidate 2 is /index.html.
      const { env, calls } = makeAssetsEnv({
        '/index.html': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      // Candidate 1 (/) misses, candidate 2 (/index.html) hits.
      expect(calls).toEqual(['/', '/index.html']);
    });
  });

  // Layer 1: unit tests against hand-mocked env.ASSETS — explicit resolution chain.
  describe('resolveAssetPath candidates (Phase 5)', () => {
    it('literal hit: /foo.js → 200 from candidate 1', async () => {
      const { env, calls } = makeAssetsEnv({
        '/foo.js': () =>
          new Response('// js', { status: 200, headers: { 'content-type': 'application/javascript' } }),
      });
      const res = await worker.fetch(new Request('https://app.example.com/foo.js'), env);
      expect(res.status).toBe(200);
      expect(calls).toEqual(['/foo.js']);
    });

    it('trailing-slash index: /about/ → /about/index.html', async () => {
      const { env, calls } = makeAssetsEnv({
        '/about/index.html': () => htmlResponse('<h1>About</h1>'),
      });
      const res = await worker.fetch(new Request('https://app.example.com/about/'), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>About</h1>');
      // Candidate 1 (/about/) misses, candidate 2 (/about/index.html) hits.
      expect(calls).toEqual(['/about/', '/about/index.html']);
    });

    it('extensionless .html lookup: /about → /about.html hit (no /about/index.html consulted)', async () => {
      const { env, calls } = makeAssetsEnv({
        '/about.html': () => htmlResponse('<h1>About</h1>'),
        '/about/index.html': () => htmlResponse('<h1>About Index</h1>'),
      });
      const res = await worker.fetch(new Request('https://app.example.com/about'), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>About</h1>');
      // Candidate 1 (/about) misses, candidate 2 (/about.html) hits — stop.
      expect(calls).toEqual(['/about', '/about.html']);
      expect(calls).not.toContain('/about/index.html');
    });

    it('extensionless dir lookup: /about with no .html but with /about/index.html', async () => {
      const { env, calls } = makeAssetsEnv({
        '/about/index.html': () => htmlResponse('<h1>About Dir</h1>'),
      });
      const res = await worker.fetch(new Request('https://app.example.com/about'), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>About Dir</h1>');
      // /about misses, /about.html misses, /about/index.html hits.
      expect(calls).toEqual(['/about', '/about.html', '/about/index.html']);
    });

    it('/foo.html real file: serves literally (200), no redirect', async () => {
      const { env, calls } = makeAssetsEnv({
        '/foo.html': () => htmlResponse('<h1>Foo</h1>'),
      });
      const res = await worker.fetch(new Request('https://app.example.com/foo.html'), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>Foo</h1>');
      // Literal hit — no extra candidates consulted, no redirect issued.
      expect(calls).toEqual(['/foo.html']);
      expect(res.headers.get('location')).toBeNull();
    });

    it('/index.html real file: serves literally (200), no redirect', async () => {
      const { env, calls } = makeAssetsEnv({
        '/index.html': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(new Request('https://app.example.com/index.html'), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      expect(calls).toEqual(['/index.html']);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  describe('SPA fallback (route-shaped miss)', () => {
    it('all candidates miss for route-shaped path → SPA fallback to /', async () => {
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
        '/index.html': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      // /history misses, /history.html misses, /history/index.html misses →
      // SPA fallback to / which returns the home document.
      expect(calls).toContain('/history');
      expect(calls[calls.length - 1]).toBe('/');
    });

    it('all candidates miss for /missing.html → SPA fallback (.html is route-shaped)', async () => {
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
        '/index.html': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/missing.html'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      // /missing.html has a .html extension → route-shaped → SPA fallback.
      expect(calls).toContain('/missing.html');
      expect(calls[calls.length - 1]).toBe('/');
    });

    it('preserves the fallback response status when the home document is also missing', async () => {
      const { env, calls } = makeAssetsEnv({}, 404);
      const res = await worker.fetch(
        new Request('https://app.example.com/missing'),
        env,
      );
      // Fallback tries / then /index.html (the resolveAssetPath candidates for /).
      // Both 404 → status 404.
      expect(res.status).toBe(404);
      // SPA fallback must have been attempted.
      expect(calls).toContain('/');
    });
  });

  describe('asset-shaped miss returns honest 404 (no SPA fallback)', () => {
    it('all candidates miss for /missing.png → 404, no SPA fallback', async () => {
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/missing.png'),
        env,
      );
      expect(res.status).toBe(404);
      // /missing.png only has 1 candidate (literal). SPA fallback must NOT fire.
      expect(calls).toEqual(['/missing.png']);
      expect(calls).not.toContain('/');
    });

    it('all candidates miss for /missing.js → 404, no SPA fallback', async () => {
      const { env, calls } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/missing.js'),
        env,
      );
      expect(res.status).toBe(404);
      expect(calls).toEqual(['/missing.js']);
      expect(calls).not.toContain('/');
    });
  });

  describe('MIME is NOT set inside the worker (Phase 6)', () => {
    it('worker passes through whatever content-type Assets set (does not override)', async () => {
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
      // Worker must not modify the content-type that Assets already set.
      expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    });

    it('worker does NOT add a content-type when Assets returned none', async () => {
      // Simulate Assets returning no content-type (as happens in WfP namespaces).
      const { env } = makeAssetsEnv({
        '/styles.css': () =>
          new Response(new TextEncoder().encode('body{}'), { status: 200 }),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/styles.css'),
        env,
      );
      // The worker must not inject a MIME type — dispatch-worker owns that.
      // content-type may be absent OR may be set by Node's fetch (text/plain
      // is acceptable here as long as the worker itself didn't synthesize it).
      // The critical assertion: it must NOT be 'text/css', 'application/javascript',
      // 'image/png', or any worker-inferred value.
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).not.toBe('text/css');
      expect(ct).not.toBe('application/javascript');
    });

    it('SPA fallback response: worker passes content-type from Assets unchanged', async () => {
      const { env } = makeAssetsEnv({
        '/': () => htmlResponse(INDEX_BODY),
        '/index.html': () => htmlResponse(INDEX_BODY),
      });
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      // text/html was set by the mock (as Assets would set it); worker didn't add it.
      // The point: whatever Assets returned, that's what came through.
      expect(res.headers.get('content-type')).toBe('text/html');
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
    it('applies a 200 rewrite rule on asset miss (serves target content under the original URL)', async () => {
      const indexBody = '<html>HOME</html>';
      // /index.html is the literal candidate for the rewrite target /index.html.
      const { env, calls } = makeAssetsEnv(
        { '/index.html': () => htmlResponse(indexBody) },
        404,
        JSON.stringify([{ from: '/*', to: '/index.html', status: 200 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(indexBody);
      // Asset lookup for /history (+ .html + /index.html) — all miss.
      // Then 200 rewrite applies: resolveAssetPath('/index.html') → ['/index.html'].
      // /index.html hits.
      expect(calls).toContain('/history');
      expect(calls).toContain('/index.html');
    });

    it('_redirects 200 rewrite: /api/* /v2/:splat — tries resolveAssetPath candidates in order', async () => {
      const v2UsersBody = '<html>V2 USERS</html>';
      // resolveAssetPath('/v2/users') = ['/v2/users', '/v2/users.html', '/v2/users/index.html']
      const { env, calls } = makeAssetsEnv(
        { '/v2/users': () => htmlResponse(v2UsersBody) },
        404,
        JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 200 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/api/users'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(v2UsersBody);
      // Asset lookup for /api/users (+ .html + /index.html) — all miss.
      // Rewrite to /v2/users — first candidate hits.
      expect(calls).toContain('/api/users');
      expect(calls).toContain('/v2/users');
    });

    it('_redirects 200 rewrite: target /v2/users.html serves via second candidate', async () => {
      const v2UsersBody = '<html>V2 USERS</html>';
      // When /v2/users misses but /v2/users.html exists, second candidate wins.
      const { env, calls } = makeAssetsEnv(
        { '/v2/users.html': () => htmlResponse(v2UsersBody) },
        404,
        JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 200 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/api/users'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(v2UsersBody);
      expect(calls).toContain('/v2/users');
      expect(calls).toContain('/v2/users.html');
    });

    it('_redirects 200 rewrite: target /v2/users/index.html serves via third candidate', async () => {
      const v2UsersBody = '<html>V2 USERS DIR</html>';
      // When /v2/users and /v2/users.html both miss, /v2/users/index.html wins.
      const { env, calls } = makeAssetsEnv(
        { '/v2/users/index.html': () => htmlResponse(v2UsersBody) },
        404,
        JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 200 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/api/users'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(v2UsersBody);
      expect(calls).toContain('/v2/users');
      expect(calls).toContain('/v2/users.html');
      expect(calls).toContain('/v2/users/index.html');
    });

    it('_redirects 3xx rule fires regardless of asset existence (rule wins)', async () => {
      const { env, calls } = makeAssetsEnv(
        { '/old': () => htmlResponse('<html>existing file</html>') },
        404,
        JSON.stringify([{ from: '/old', to: '/new', status: 301 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/old'),
        env,
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://app.example.com/new');
      // Asset must not be consulted — the 3xx rule preempts the lookup.
      expect(calls).toEqual([]);
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

    it('first match wins for 3xx rules (preserves rule order)', async () => {
      const { env, calls } = makeAssetsEnv(
        {},
        404,
        JSON.stringify([
          { from: '/foo', to: '/specific', status: 301 },
          { from: '/*', to: '/catchall', status: 301 },
        ]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/foo'),
        env,
      );
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('https://app.example.com/specific');
      expect(calls).toEqual([]);
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
      // Asset lookup for /api/users/42 first (misses), then rewrite to /v2/users/42.
      expect(calls).toContain('/api/users/42');
      expect(calls).toContain('/v2/users/42');
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

    it('falls through to default SPA fallback when no rule matches', async () => {
      const indexBody = '<html>HOME</html>';
      const { env, calls } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody), '/index.html': () => htmlResponse(indexBody) },
        404,
        JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 301 }]),
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/unrelated/deep/path'),
        env,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(indexBody);
      expect(calls).toContain('/unrelated/deep/path');
      expect(calls[calls.length - 1]).toBe('/');
    });

    it('treats absent BB_REDIRECTS_RULES as no rules (existing behavior unchanged)', async () => {
      const indexBody = '<html>HOME</html>';
      const { env, calls } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody), '/index.html': () => htmlResponse(indexBody) },
        404,
        // no rulesJson argument
      );
      const res = await worker.fetch(
        new Request('https://app.example.com/history'),
        env,
      );
      expect(res.status).toBe(200);
      expect(calls[calls.length - 1]).toBe('/');
    });

    it('treats malformed BB_REDIRECTS_RULES JSON as no rules (does not break serving)', async () => {
      const indexBody = '<html>HOME</html>';
      const { env } = makeAssetsEnv(
        { '/': () => htmlResponse(indexBody), '/index.html': () => htmlResponse(indexBody) },
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

    describe('CF Pages-compatible precedence (assets vs rules)', () => {
      it('3xx rule fires even when the requested path is a real asset (rule wins)', async () => {
        const { env, calls } = makeAssetsEnv(
          { '/old': () => htmlResponse('<html>existing file</html>') },
          404,
          JSON.stringify([{ from: '/old', to: '/new', status: 301 }]),
        );
        const res = await worker.fetch(
          new Request('https://app.example.com/old'),
          env,
        );
        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('https://app.example.com/new');
        // Asset must not be consulted — the 3xx rule preempts the lookup.
        expect(calls).toEqual([]);
      });

      it('200 rewrite does NOT fire when the requested path is a real asset (asset wins)', async () => {
        const assetBody = '<html>real file</html>';
        const indexBody = '<html>HOME</html>';
        const { env, calls } = makeAssetsEnv(
          {
            '/new.html': () => htmlResponse(assetBody),
            '/': () => htmlResponse(indexBody),
          },
          404,
          JSON.stringify([{ from: '/*', to: '/index.html', status: 200 }]),
        );
        const res = await worker.fetch(
          new Request('https://app.example.com/new.html'),
          env,
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(assetBody);
        // Asset served directly. No rewrite applied.
        expect(calls).toEqual(['/new.html']);
      });

      it('200 rewrite fires when the requested path is NOT a real asset (rule fallback)', async () => {
        const indexBody = '<html>HOME</html>';
        const { env, calls } = makeAssetsEnv(
          { '/index.html': () => htmlResponse(indexBody) },
          404,
          JSON.stringify([{ from: '/*', to: '/index.html', status: 200 }]),
        );
        const res = await worker.fetch(
          new Request('https://app.example.com/missing'),
          env,
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(indexBody);
        expect(calls).toContain('/missing');
        expect(calls).toContain('/index.html');
      });

      it('200 rewrite target miss → SPA fallback for route-shaped path', async () => {
        // When the rewrite target also misses, route-shaped paths fall through to SPA.
        const indexBody = '<html>HOME</html>';
        const { env } = makeAssetsEnv(
          { '/': () => htmlResponse(indexBody), '/index.html': () => htmlResponse(indexBody) },
          404,
          JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 200 }]),
        );
        const res = await worker.fetch(
          new Request('https://app.example.com/api/missing-route'),
          env,
        );
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(indexBody);
      });

      it('200 rewrite target miss → 404 for asset-shaped path', async () => {
        // When the rewrite target also misses and the path is asset-shaped, return 404.
        const { env } = makeAssetsEnv(
          { '/': () => htmlResponse('<html>HOME</html>') },
          404,
          JSON.stringify([{ from: '/api/*', to: '/v2/:splat', status: 200 }]),
        );
        const res = await worker.fetch(
          new Request('https://app.example.com/api/missing.png'),
          env,
        );
        expect(res.status).toBe(404);
      });
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
