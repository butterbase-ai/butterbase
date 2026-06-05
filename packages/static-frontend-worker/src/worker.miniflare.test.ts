// Integration tests for the static frontend worker against a real workerd
// runtime via Miniflare. Complements src/worker.test.ts (which exercises the
// handler against a hand-mocked env.ASSETS) by running the actual deployed
// worker bundle with a real Assets binding configured the same way prod is
// configured (html_handling: 'none').
//
// These tests catch a class of regression the hand-mock cannot: behaviors
// that depend on the real Assets binding's response semantics. With
// html_handling: 'none', extensionless paths return 404 from Assets — no
// redirects. The worker's resolveAssetPath candidates handle path resolution
// explicitly. If CF ever changes Assets binding semantics, this test will
// surface the change concretely; the unit tests would still pass because they
// mock the old behavior.
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

// ---------------------------------------------------------------------------
// Fixture 1: Basic SPA fixture (index.html + about.html + assets).
// Used by the main Miniflare instance.
// ---------------------------------------------------------------------------

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
    port: 0,
    assets: {
      directory: assetsDir,
      binding: 'ASSETS',
      assetConfig: {
        // Phase 5: use 'none' so Assets returns literal 2xx-or-404.
        // No implicit CF URL canonicalization or redirects in the loop.
        html_handling: 'none',
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

    it('resolves /about (extensionless) to /about.html via worker candidate-2 lookup', async () => {
      // Under html_handling: 'none', Assets returns 404 for /about.
      // The worker's resolveAssetPath tries /about.html → hits.
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
      // Under html_handling: 'none', /history returns 404 (not 307).
      // The worker's resolveAssetPath tries /history, /history.html, /history/index.html —
      // all miss — then SPA fallback to / → /index.html → 200.
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
      // observer would see the 307 if the bug was reintroduced.
      for (const path of ['/history', '/profile', '/result/xyz', '/__missing']) {
        const res = await get(path);
        expect(res.status, `path=${path} should not be 307`).not.toBe(307);
        expect(res.headers.get('location'), `path=${path} should have no Location header`).toBeNull();
      }
    });
  });

  describe('/index.html and /foo.html serve literally (Phase 5 behavior change)', () => {
    it('/about.html serves literally with 200 (no canonical redirect)', async () => {
      const res = await get('/about.html');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(ABOUT_BODY);
      expect(res.headers.get('location')).toBeNull();
    });

    it('/index.html serves literally with 200 (no canonical redirect)', async () => {
      const res = await get('/index.html');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_BODY);
      expect(res.headers.get('location')).toBeNull();
    });
  });

  describe('asset-shaped miss returns 404 (no SPA fallback)', () => {
    it('/missing.png → 404 (binary extension, no SPA fallback)', async () => {
      const res = await get('/missing.png');
      expect(res.status).toBe(404);
      // The body must not be INDEX_BODY — no SPA fallback fired.
      const body = await res.text();
      expect(body).not.toBe(INDEX_BODY);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: Fixture with _redirects rules (BB_REDIRECTS_RULES binding).
// ---------------------------------------------------------------------------
describe('static-frontend-worker rule application via Miniflare', () => {
  let mfRules: Miniflare;
  let baseUrlRules: URL;
  let rulesAssetsDir: string;

  const NEW_BODY = '<!doctype html><h1>NEW</h1>';
  const V2_USERS_BODY = '<!doctype html><h1>V2 USERS</h1>';
  const RULES = [
    { from: '/old', to: '/new.html', status: 301 },
    { from: '/api/*', to: '/v2/:splat', status: 200 },
    { from: '/go-google', to: 'https://google.com', status: 302 },
    { from: '/*', to: '/index.html', status: 200 },
  ];

  beforeAll(async () => {
    const workerSource = readFileSync(workerJsPath, 'utf8');

    rulesAssetsDir = mkdtempSync(join(tmpdir(), 'bb-mf-rules-'));
    writeFileSync(join(rulesAssetsDir, 'index.html'), INDEX_BODY);
    writeFileSync(join(rulesAssetsDir, 'new.html'), NEW_BODY);
    mkdirSync(join(rulesAssetsDir, 'v2'), { recursive: true });
    writeFileSync(join(rulesAssetsDir, 'v2', 'users.html'), V2_USERS_BODY);

    mfRules = new Miniflare({
      modules: true,
      script: workerSource,
      host: '127.0.0.1',
      port: 0,
      bindings: { BB_REDIRECTS_RULES: JSON.stringify(RULES) },
      assets: {
        directory: rulesAssetsDir,
        binding: 'ASSETS',
        // Phase 5: 'none' matches prod.
        assetConfig: { html_handling: 'none' },
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: true,
        },
      },
    });
    baseUrlRules = await mfRules.ready;
  }, 30_000);

  afterAll(async () => {
    if (mfRules) await mfRules.dispose();
    if (rulesAssetsDir) rmSync(rulesAssetsDir, { recursive: true, force: true });
  });

  async function getRules(path: string): Promise<Response> {
    return await mfRules.dispatchFetch(new URL(path, baseUrlRules).toString(), {
      redirect: 'manual',
    });
  }

  it('applies a 301 redirect: /old → 301 Location: /new.html', async () => {
    const res = await getRules('/old');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(
      new URL('/new.html', baseUrlRules).toString(),
    );
  });

  it('applies a 200 rewrite with :splat substitution: /api/users → serves /v2/users.html content', async () => {
    // Under html_handling: 'none', resolveAssetPath('/v2/users') tries
    // /v2/users (404), then /v2/users.html (200) → serves V2_USERS_BODY.
    const res = await getRules('/api/users');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(V2_USERS_BODY);
  });

  it('applies a 302 redirect to an external URL: /go-google → 302 https://google.com', async () => {
    const res = await getRules('/go-google');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://google.com');
  });

  it('catch-all SPA rule /* → /index.html serves home for unmatched deep paths', async () => {
    const res = await getRules('/some/deep/route');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });

  it('catch-all SPA rule still routes the exact home path to index', async () => {
    const res = await getRules('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });

  it('first match wins: /old → redirect (not the /* SPA rule)', async () => {
    const res = await getRules('/old');
    expect(res.status).toBe(301);
    // If the SPA rule had won we would get 200 + INDEX_BODY.
  });

  it('first match wins: /api/users → rewrite (not the /* SPA rule)', async () => {
    const res = await getRules('/api/users');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(V2_USERS_BODY);
    // If the SPA rule had won we would get INDEX_BODY.
  });

  // Under html_handling: 'none', /new.html is a real file that Assets serves
  // with 200 directly (no 307 canonicalization). The /* SPA rule MUST NOT
  // swallow it — real assets win over 200 rewrites.
  it('real asset wins over /* SPA rewrite: /new.html → 200 served literally (no 307)', async () => {
    const res = await getRules('/new.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(NEW_BODY);
    // Confirm no 307 or Location header — the old auto-trailing-slash behavior is gone.
    expect(res.headers.get('location')).toBeNull();
  });

  it('the canonical /new path serves the actual file via candidate-2 lookup', async () => {
    // resolveAssetPath('/new') → ['/new', '/new.html', '/new/index.html'].
    // /new misses, /new.html hits.
    const res = await getRules('/new');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(NEW_BODY);
    // If the /* rule had won we would get INDEX_BODY.
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: Multi-page static site (no SPA fallback expected).
// ---------------------------------------------------------------------------
describe('multi-page static fixture', () => {
  let mfMps: Miniflare;
  let baseUrlMps: URL;
  let mpsAssetsDir: string;

  const CONTACT_BODY = '<!doctype html><h1>Contact</h1>';
  const POST1_BODY = '<!doctype html><h1>Post 1</h1>';

  beforeAll(async () => {
    const workerSource = readFileSync(workerJsPath, 'utf8');

    mpsAssetsDir = mkdtempSync(join(tmpdir(), 'bb-mf-mps-'));
    writeFileSync(join(mpsAssetsDir, 'index.html'), INDEX_BODY);
    writeFileSync(join(mpsAssetsDir, 'about.html'), ABOUT_BODY);
    writeFileSync(join(mpsAssetsDir, 'contact.html'), CONTACT_BODY);
    mkdirSync(join(mpsAssetsDir, 'blog'), { recursive: true });
    writeFileSync(join(mpsAssetsDir, 'blog', 'post-1.html'), POST1_BODY);
    // No _redirects shipped.

    mfMps = new Miniflare({
      modules: true,
      script: workerSource,
      host: '127.0.0.1',
      port: 0,
      assets: {
        directory: mpsAssetsDir,
        binding: 'ASSETS',
        assetConfig: { html_handling: 'none' },
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: true,
        },
      },
    });
    baseUrlMps = await mfMps.ready;
  }, 30_000);

  afterAll(async () => {
    if (mfMps) await mfMps.dispose();
    if (mpsAssetsDir) rmSync(mpsAssetsDir, { recursive: true, force: true });
  });

  async function getMps(path: string): Promise<Response> {
    return await mfMps.dispatchFetch(new URL(path, baseUrlMps).toString(), {
      redirect: 'manual',
    });
  }

  it('/about → 200 with about body (candidate-2 .html lookup)', async () => {
    const res = await getMps('/about');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ABOUT_BODY);
  });

  it('/contact → 200 with contact body (candidate-2 .html lookup)', async () => {
    const res = await getMps('/contact');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTACT_BODY);
  });

  it('/blog/post-1 → 200 with post-1 body (candidate-2 .html lookup)', async () => {
    const res = await getMps('/blog/post-1');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(POST1_BODY);
  });

  it('/missing.png → 404 (asset-shaped, no SPA fallback)', async () => {
    const res = await getMps('/missing.png');
    expect(res.status).toBe(404);
    // Body must not be INDEX_BODY — no SPA fallback fired.
    const body = await res.text();
    expect(body).not.toBe(INDEX_BODY);
  });
});

// ---------------------------------------------------------------------------
// Fixture 4: Pure SPA (index.html only, no _redirects).
// ---------------------------------------------------------------------------
describe('SPA fixture (index.html only)', () => {
  let mfSpa: Miniflare;
  let baseUrlSpa: URL;
  let spaAssetsDir: string;

  beforeAll(async () => {
    const workerSource = readFileSync(workerJsPath, 'utf8');

    spaAssetsDir = mkdtempSync(join(tmpdir(), 'bb-mf-spa-'));
    writeFileSync(join(spaAssetsDir, 'index.html'), INDEX_BODY);
    // No _redirects shipped.

    mfSpa = new Miniflare({
      modules: true,
      script: workerSource,
      host: '127.0.0.1',
      port: 0,
      assets: {
        directory: spaAssetsDir,
        binding: 'ASSETS',
        assetConfig: { html_handling: 'none' },
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: true,
        },
      },
    });
    baseUrlSpa = await mfSpa.ready;
  }, 30_000);

  afterAll(async () => {
    if (mfSpa) await mfSpa.dispose();
    if (spaAssetsDir) rmSync(spaAssetsDir, { recursive: true, force: true });
  });

  async function getSpa(path: string): Promise<Response> {
    return await mfSpa.dispatchFetch(new URL(path, baseUrlSpa).toString(), {
      redirect: 'manual',
    });
  }

  it('/ → 200 home', async () => {
    const res = await getSpa('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });

  it('/history → 200 home via SPA fallback', async () => {
    const res = await getSpa('/history');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });

  it('/profile/42 → 200 home via SPA fallback', async () => {
    const res = await getSpa('/profile/42');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });

  it('/missing.png → 404 (asset-shaped, no SPA fallback)', async () => {
    const res = await getSpa('/missing.png');
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toBe(INDEX_BODY);
  });
});

// ---------------------------------------------------------------------------
// Fixture 5: Mixed fixture (/index.html, /old.html, _redirects with 301 + /*).
// ---------------------------------------------------------------------------
describe('mixed fixture (static pages + redirects + SPA catch-all)', () => {
  let mfMixed: Miniflare;
  let baseUrlMixed: URL;
  let mixedAssetsDir: string;

  const OLD_BODY = '<!doctype html><h1>Old Page</h1>';
  const MIXED_RULES = [
    { from: '/old', to: '/new', status: 301 },
    { from: '/*', to: '/index.html', status: 200 },
  ];

  beforeAll(async () => {
    const workerSource = readFileSync(workerJsPath, 'utf8');

    mixedAssetsDir = mkdtempSync(join(tmpdir(), 'bb-mf-mixed-'));
    writeFileSync(join(mixedAssetsDir, 'index.html'), INDEX_BODY);
    writeFileSync(join(mixedAssetsDir, 'old.html'), OLD_BODY);

    mfMixed = new Miniflare({
      modules: true,
      script: workerSource,
      host: '127.0.0.1',
      port: 0,
      bindings: { BB_REDIRECTS_RULES: JSON.stringify(MIXED_RULES) },
      assets: {
        directory: mixedAssetsDir,
        binding: 'ASSETS',
        assetConfig: { html_handling: 'none' },
        routerConfig: {
          has_user_worker: true,
          invoke_user_worker_ahead_of_assets: true,
        },
      },
    });
    baseUrlMixed = await mfMixed.ready;
  }, 30_000);

  afterAll(async () => {
    if (mfMixed) await mfMixed.dispose();
    if (mixedAssetsDir) rmSync(mixedAssetsDir, { recursive: true, force: true });
  });

  async function getMixed(path: string): Promise<Response> {
    return await mfMixed.dispatchFetch(new URL(path, baseUrlMixed).toString(), {
      redirect: 'manual',
    });
  }

  it('/old → 301 (3xx rule wins over everything)', async () => {
    const res = await getMixed('/old');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toMatch(/\/new/);
  });

  it('/old.html → 200 served literally (real asset wins over /* SPA rewrite)', async () => {
    const res = await getMixed('/old.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(OLD_BODY);
  });

  it('/missing → 200 home (/* SPA rewrite catches route-shaped miss)', async () => {
    const res = await getMixed('/missing');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });

  it('/missing.png is rewritten to /index.html when /* /index.html 200 catches it (rewrite fires before asset-shape gate)', async () => {
    // The asset-shape gate (non-html-extension → 404) only runs when no 200
    // rewrite rule matches. Here /* /index.html 200 matches first, so the
    // worker returns the SPA shell with status 200 — identical to CF Pages
    // behavior when the user ships this catch-all rule.
    const res = await getMixed('/missing.png');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_BODY);
  });
});
