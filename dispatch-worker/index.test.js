import { describe, it, expect, vi } from 'vitest';
import { parseKvValue, hashVisitor, beaconVisit, isHumanPageLoad, pausedResponse, handleRequest } from './index.js';

describe('parseKvValue', () => {
  const env = { BUTTERBASE_REGION: 'us-east-1' };

  it('returns null for missing value', () => {
    expect(parseKvValue(null, env)).toBeNull();
  });

  it('parses JSON value', () => {
    expect(parseKvValue('{"appId":"a","region":"eu-west-1"}', env)).toEqual({ appId: 'a', region: 'eu-west-1' });
  });

  it('falls back to local region for JSON without region', () => {
    expect(parseKvValue('{"appId":"a"}', env)).toEqual({ appId: 'a', region: 'us-east-1' });
  });

  it('treats legacy string value as local region', () => {
    expect(parseKvValue('legacy-app-id', env)).toEqual({ appId: 'legacy-app-id', region: 'us-east-1' });
  });
});

describe('hashVisitor', () => {
  it('returns a stable 16-char hex for the same IP+UA', async () => {
    const a = await hashVisitor('1.2.3.4', 'Mozilla/5.0');
    const b = await hashVisitor('1.2.3.4', 'Mozilla/5.0');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs for different IPs', async () => {
    const a = await hashVisitor('1.2.3.4', 'Mozilla/5.0');
    const b = await hashVisitor('5.6.7.8', 'Mozilla/5.0');
    expect(a).not.toBe(b);
  });

  it('handles missing ip and UA gracefully', async () => {
    const a = await hashVisitor(null, null);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('beaconVisit', () => {
  it('no-ops silently when CONTROL_API_URL is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await beaconVisit({ BUTTERBASE_INTERNAL_SECRET: 'x' }, 'app1', '1.2.3.4', 'ua');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('no-ops silently when BUTTERBASE_INTERNAL_SECRET is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null));
    await beaconVisit({ CONTROL_API_URL: 'https://c/' }, 'app1', '1.2.3.4', 'ua');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('POSTs to /v1/internal/visit-beacon with the correct body and header', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await beaconVisit(
      { CONTROL_API_URL: 'https://c.example', BUTTERBASE_INTERNAL_SECRET: 'sekret' },
      'app-123', '1.2.3.4', 'ua'
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://c.example/v1/internal/visit-beacon');
    expect(init.headers['x-butterbase-internal-secret']).toBe('sekret');
    const body = JSON.parse(init.body);
    expect(body.app_id).toBe('app-123');
    expect(body.count).toBe(1);
    expect(body.unique_hashes).toHaveLength(1);
    expect(body.unique_hashes[0]).toMatch(/^[0-9a-f]{16}$/);
    fetchSpy.mockRestore();
  });

  it('never throws when fetch rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await expect(
      beaconVisit(
        { CONTROL_API_URL: 'https://c.example', BUTTERBASE_INTERNAL_SECRET: 'x' },
        'app', '1.2.3.4', 'ua'
      )
    ).resolves.not.toThrow();
    fetchSpy.mockRestore();
  });
});

describe('parseKvValue paused', () => {
  const env = { BUTTERBASE_REGION: 'us-east-1' };
  it('returns paused only when true', () => {
    expect(parseKvValue('{"appId":"a","region":"r","paused":true}', env)).toEqual({ appId: 'a', region: 'r', paused: true });
    expect(parseKvValue('{"appId":"a","region":"r","paused":false}', env)).toEqual({ appId: 'a', region: 'r' });
  });
});

describe('isHumanPageLoad', () => {
  const req = (headers, method = 'GET') => new Request('https://x.butterbase.dev/', { method, headers });
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
  it('counts a browser navigation', () => {
    expect(isHumanPageLoad(req({ 'user-agent': chrome, 'sec-fetch-dest': 'document' }))).toBe(true);
  });
  it('counts an old browser with no sec-fetch-dest but Accept text/html', () => {
    expect(isHumanPageLoad(req({ 'user-agent': chrome, accept: 'text/html,application/xhtml+xml' }))).toBe(true);
  });
  it('ignores assets, scripts and fetches', () => {
    expect(isHumanPageLoad(req({ 'user-agent': chrome, 'sec-fetch-dest': 'script' }))).toBe(false);
    expect(isHumanPageLoad(req({ 'user-agent': chrome, 'sec-fetch-dest': 'empty' }))).toBe(false);
    expect(isHumanPageLoad(req({ 'user-agent': chrome, accept: '*/*' }))).toBe(false);
  });
  it('ignores prefetches and non-GET', () => {
    expect(isHumanPageLoad(req({ 'user-agent': chrome, 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch' }))).toBe(false);
    expect(isHumanPageLoad(req({ 'user-agent': chrome, 'sec-fetch-dest': 'document' }, 'POST'))).toBe(false);
  });
  it.each([
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0)',
    'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
    'facebookexternalhit/1.1',
    'curl/8.4.0', 'Wget/1.21', 'python-requests/2.31', 'node-fetch/1.0', 'axios/1.7.2', 'Go-http-client/2.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36',
  ])('ignores crawler %s', (ua) => {
    expect(isHumanPageLoad(req({ 'user-agent': ua, 'sec-fetch-dest': 'document', accept: 'text/html' }))).toBe(false);
  });
  it('ignores a missing user-agent', () => {
    expect(isHumanPageLoad(req({ 'sec-fetch-dest': 'document' }))).toBe(false);
  });
});

describe('pausedResponse', () => {
  it('is a neutral, uncached, unindexed 503', async () => {
    const res = pausedResponse({ DASHBOARD_URL: 'https://dash.example' });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('This project is paused.');
    expect(html).toContain('href="https://dash.example"');
    expect(html).toContain('Open the Butterbase dashboard.');
  });
  it('falls back to the production dashboard', async () => {
    expect(await pausedResponse({}).text()).toContain('href="https://dashboard.butterbase.ai"');
  });
});

describe('handleRequest with a paused app', () => {
  const browser = { 'user-agent': 'Mozilla/5.0 Chrome/129.0', 'sec-fetch-dest': 'document' };
  function setup(kvValue) {
    const workerFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const env = {
      BUTTERBASE_REGION: 'us-east-1', CONTROL_API_URL: 'https://c', BUTTERBASE_INTERNAL_SECRET: 's',
      SUBDOMAINS: { get: vi.fn(async () => kvValue) },
      DISPATCHER: { get: vi.fn(() => ({ fetch: workerFetch })) },
    };
    const ctx = { waitUntil: vi.fn() };
    return { env, ctx, workerFetch };
  }
  it('serves the paused page and never beacons', async () => {
    const { env, ctx, workerFetch } = setup('{"appId":"app_1","region":"us-east-1","paused":true}');
    const res = await handleRequest(new Request('https://cool.butterbase.dev/', { headers: browser }), env, ctx);
    expect(res.status).toBe(503);
    expect(workerFetch).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
  it('passes /_do/ through for a paused app', async () => {
    const { env, ctx, workerFetch } = setup('{"appId":"app_1","region":"us-east-1","paused":true}');
    const res = await handleRequest(new Request('https://cool.butterbase.dev/_do/room/1', { headers: browser }), env, ctx);
    expect(res.status).toBe(200);
    expect(env.DISPATCHER.get).toHaveBeenCalledWith('app_1_do');
    expect(workerFetch).toHaveBeenCalled();
  });
  it('beacons a human page load on a running app, not an asset', async () => {
    const { env, ctx } = setup('{"appId":"app_1","region":"us-east-1"}');
    await handleRequest(new Request('https://cool.butterbase.dev/', { headers: browser }), env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await handleRequest(new Request('https://cool.butterbase.dev/app.js', { headers: { ...browser, 'sec-fetch-dest': 'script' } }), env, ctx);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });
});
