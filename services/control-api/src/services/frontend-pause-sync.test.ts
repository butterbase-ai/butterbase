import { describe, it, expect, vi, beforeEach } from 'vitest';

const kv = new Map<string, string>();
vi.mock('./cloudflare-wfp.js', () => ({
  readKvMapping: vi.fn(async (k: string) => kv.get(k) ?? null),
  writeSubdomainMapping: vi.fn(async (s: string, appId: string, region: string, paused = false) => {
    kv.set(`sub:${s}`, JSON.stringify(paused ? { appId, region, paused: true } : { appId, region }));
  }),
  writeDomainMapping: vi.fn(async (h: string, appId: string, region: string, paused = false) => {
    kv.set(`domain:${h}`, JSON.stringify(paused ? { appId, region, paused: true } : { appId, region }));
  }),
}));
const runtimeQuery = vi.fn();
vi.mock('./region-resolver.js', () => ({ getRuntimeDbForApp: vi.fn(async () => ({ query: runtimeQuery })) }));
vi.mock('../config.js', () => ({ config: { cloudflare: { subdomainKvId: 'kv1' } } }));

import { syncFrontendPausedState } from './frontend-pause-sync.js';

function appRow(over: Record<string, unknown> = {}) {
  return { subdomain: 'cool', region: 'us-east-1', paused: true, deployment_backend: 'wfp', ...over };
}
function mockApp(row: Record<string, unknown> | null, hostnames: string[] = []) {
  runtimeQuery.mockImplementation(async (sql: string) =>
    /FROM apps/.test(sql) ? { rows: row ? [row] : [] } : { rows: hostnames.map((hostname) => ({ hostname })) });
}

beforeEach(() => { kv.clear(); runtimeQuery.mockReset(); });

describe('syncFrontendPausedState', () => {
  it('sets paused on the subdomain and every live custom domain', async () => {
    kv.set('sub:cool', '{"appId":"app_1","region":"us-east-1"}');
    kv.set('domain:cool.com', '{"appId":"app_1","region":"us-east-1"}');
    mockApp(appRow(), ['cool.com']);
    const r = await syncFrontendPausedState({ query: vi.fn() }, 'app_1');
    expect(JSON.parse(kv.get('sub:cool')!)).toEqual({ appId: 'app_1', region: 'us-east-1', paused: true });
    expect(JSON.parse(kv.get('domain:cool.com')!)).toEqual({ appId: 'app_1', region: 'us-east-1', paused: true });
    expect(r.rewritten).toEqual(['sub:cool', 'domain:cool.com']);
  });

  it('clears paused on resume', async () => {
    kv.set('sub:cool', '{"appId":"app_1","region":"us-east-1","paused":true}');
    mockApp(appRow({ paused: false }));
    await syncFrontendPausedState({ query: vi.fn() }, 'app_1');
    expect(kv.get('sub:cool')).toBe('{"appId":"app_1","region":"us-east-1"}');
  });

  it('keeps the existing appId (placeholder)', async () => {
    kv.set('sub:cool', '{"appId":"__placeholder__","region":"us-east-1"}');
    mockApp(appRow());
    await syncFrontendPausedState({ query: vi.fn() }, 'app_1');
    expect(JSON.parse(kv.get('sub:cool')!).appId).toBe('__placeholder__');
  });

  it('reads a legacy plain-string value as the appId', async () => {
    kv.set('sub:cool', 'app_1');
    mockApp(appRow());
    await syncFrontendPausedState({ query: vi.fn() }, 'app_1');
    expect(JSON.parse(kv.get('sub:cool')!)).toEqual({ appId: 'app_1', region: 'us-east-1', paused: true });
  });

  it("skips keys that don't exist", async () => {
    mockApp(appRow(), ['nope.com']);
    const r = await syncFrontendPausedState({ query: vi.fn() }, 'app_1');
    expect(kv.size).toBe(0);
    expect(r.rewritten).toEqual([]);
  });

  it('does nothing for pages apps, missing apps, or no subdomain', async () => {
    mockApp(appRow({ deployment_backend: 'pages' }));
    expect((await syncFrontendPausedState({ query: vi.fn() }, 'app_1')).rewritten).toEqual([]);
    mockApp(null);
    expect((await syncFrontendPausedState({ query: vi.fn() }, 'app_1')).rewritten).toEqual([]);
  });

  it('only reads live custom domains', async () => {
    mockApp(appRow(), []);
    await syncFrontendPausedState({ query: vi.fn() }, 'app_1');
    const domainSql = runtimeQuery.mock.calls.map((c) => c[0]).find((s: string) => /app_custom_domains/.test(s));
    expect(domainSql).toMatch(/archived_after_move IS NULL/);
  });
});
