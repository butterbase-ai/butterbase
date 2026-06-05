// Integration tests for the static frontend worker against a real workerd
// runtime via Miniflare. Complements src/worker.test.ts (which exercises the
// handler against a hand-mocked env.ASSETS) by running the actual deployed
// worker bundle with a real Assets binding configured the same way prod is
// configured (html_handling: 'auto-trailing-slash').
//
// These tests catch a class of regression the hand-mock cannot: behaviors
// that depend on the real Assets binding's response semantics — most
// importantly the 307-from-Assets-on-extensionless-miss that PR #33's
// fallback exists to escape. If CF ever changes that behavior (e.g. to 404
// instead of 307), this test will surface the change concretely; the unit
// tests would still pass because they mock the old behavior.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const workerJsPath = join(packageRoot, 'dist', 'worker.js');

const INDEX_BODY = '<!doctype html><html><body><div id="root"></div></body></html>';
const ABOUT_BODY = '<!doctype html><h1>About</h1>';
const CSS_BODY = 'body{color:red}';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let mf: Miniflare;
let baseUrl: URL;
let assetsDir: string;

beforeAll(async () => {
  const workerSource = readFileSync(workerJsPath, 'utf8');

  assetsDir = mkdtempSync(join(tmpdir(), 'bb-mf-assets-'));
  writeFileSync(join(assetsDir, 'index.html'), INDEX_BODY);
  writeFileSync(join(assetsDir, 'about.html'), ABOUT_BODY);
  mkdirSync(join(assetsDir, 'assets'), { recursive: true });
  writeFileSync(join(assetsDir, 'assets', 'app.css'), CSS_BODY);
  writeFileSync(join(assetsDir, 'logo.png'), PNG_BYTES);

  mf = new Miniflare({
    modules: true,
    script: workerSource,
    host: '127.0.0.1',
    port: 0, // Let Miniflare pick a free port
    assets: {
      directory: assetsDir,
      binding: 'ASSETS',
      assetConfig: {
        // Mirror production config — this is the setting that produces the
        // 307-on-/index.html behavior PR #33's fallback was built to escape.
        html_handling: 'auto-trailing-slash',
      },
      // In a WfP dispatch namespace the user worker is the entry point and
      // env.ASSETS is just a binding it can choose to call. Miniflare's
      // default routes assets ahead of the user worker (the standalone
      // Workers Static Assets product behavior), which would mean our SPA
      // fallback never runs because Assets returns 404 directly to the
      // client. These two flags make the user worker the entry, matching
      // prod.
      routerConfig: {
        has_user_worker: true,
        invoke_user_worker_ahead_of_assets: true,
      },
    },
  });
  baseUrl = await mf.ready;
}, 30_000);

afterAll(async () => {
  if (mf) await mf.dispose();
  if (assetsDir) rmSync(assetsDir, { recursive: true, force: true });
});

async function get(path: string, init?: RequestInit): Promise<Response> {
  return await mf.dispatchFetch(new URL(path, baseUrl).toString(), {
    redirect: 'manual',
    ...init,
  });
}

describe('static-frontend-worker via Miniflare (real workerd)', () => {
  describe('happy path', () => {
    it('serves an existing asset directly with the expected status + body', async () => {
      const res = await get('/assets/app.css');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(CSS_BODY);
      expect(res.headers.get('content-type')).toMatch(/text\/css/);
    });

    it('serves the root path with the home index.html', async () => {
      const res = await get('/');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
    });

    it('resolves /about (extensionless) to /about.html via html_handling: auto-trailing-slash', async () => {
      const res = await get('/about');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(ABOUT_BODY);
    });

    it('round-trips binary bytes (image/png) unchanged', async () => {
      const res = await get('/logo.png');
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bytes)).toEqual(Array.from(PNG_BYTES));
    });
  });

  describe('SPA fallback against real CF semantics (PR #33 regression guard)', () => {
    it('deep path that does not exist resolves to the home index.html with status 200', async () => {
      // This is the canonical PR #33 case. Against the REAL Assets binding
      // (not a hand-mock), /history with no matching file should: first
      // attempt returns non-2xx, worker falls back to /, returns 200.
      const res = await get('/history');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
    });

    it('nested deep path also resolves to the home index.html', async () => {
      const res = await get('/result/abc-123/details');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
    });

    it('the worker NEVER returns a 307 redirect to /', async () => {
      // The exact symptom the user reported. With redirect: manual the test
      // observer would see the 307 if the bug was reintroduced. This is the
      // strongest regression guard the package can carry: it runs the
      // production worker bundle against the production Assets configuration.
      for (const path of ['/history', '/profile', '/result/xyz', '/__missing']) {
        const res = await get(path);
        expect(res.status, `path=${path} should not be 307`).not.toBe(307);
        expect(res.headers.get('location'), `path=${path} should have no Location header`).toBeNull();
      }
    });
  });

  describe('content-type defaults via worker withMime', () => {
    it('serves CSS with text/css', async () => {
      const res = await get('/assets/app.css');
      expect(res.headers.get('content-type')).toMatch(/text\/css/);
    });

    it('serves PNG with image/png', async () => {
      const res = await get('/logo.png');
      expect(res.headers.get('content-type')).toMatch(/image\/png/);
    });

    it('serves the SPA fallback as text/html (even though the request was for an extensionless path)', async () => {
      const res = await get('/history');
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
    });
  });
});
