import { describe, it, expect, vi } from 'vitest';
import { routeChatCompletion } from './router.js';
import { createStickyBindings, sessionKey, prefixKey, hashCacheablePrefix, type KVClient } from './sticky-bindings.js';
import { AdapterError, type RouterAdapter, type ChatCompletionRequest } from './adapters/types.js';

vi.mock('./billing-gate.js', () => ({
  acquireForEstimatedCost: vi.fn(async () => ({ leaseId: 'lease-1', amountGrantedUsd: 1, expiresAt: new Date() })),
  settleAfterCall: vi.fn(async () => ({ refundedUsd: 0 })),
  leaseTtlSeconds: vi.fn(() => 60),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

vi.mock('./usage-log.js', () => ({
  writeAiUsageRow: vi.fn(async () => {}),
}));

vi.mock('../auto-refill-service.js', () => ({
  maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// In-memory KV with TTL recording, satisfying the KVClient interface.
// ---------------------------------------------------------------------------
function makeKvSpy() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  let lastTtl: number | undefined;
  const kv: KVClient = {
    async get(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    async put(key, value, opts) {
      store.set(key, value);
      lastTtl = opts?.expirationTtl;
      ttls.set(key, lastTtl);
    },
    async delete(key) {
      store.delete(key);
      ttls.delete(key);
    },
  };
  return {
    kv,
    bindings: createStickyBindings(kv),
    get lastTtl() { return lastTtl; },
    ttls,
    store,
  };
}

function makePoolStub() {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [{ user_id: 'u', credits_usd: '100', amount_usd: '100', status: 'active' }] })),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [] })),
  } as any;
}

function makeRedis(catalogEntry: any, routers: any[]) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:m') return JSON.stringify(catalogEntry);
      if (key === 'ai_catalog:routers') return JSON.stringify(routers);
      return null;
    }),
  } as any;
}

function entryMulti(...routers: Array<{ name: string; pp: number; cp: number }>) {
  return {
    canonicalId: 'm',
    displayName: 'm',
    updatedAt: new Date().toISOString(),
    routers: routers.map(r => ({ name: r.name, upstreamId: 'm', promptPricePerMtok: r.pp, completionPricePerMtok: r.cp, contextLength: 1000 })),
  };
}

function okAdapter(): RouterAdapter {
  return {
    name: 'unused' as any,
    toUpstreamId: () => 'm',
    listModels: vi.fn(async () => []),
    chatCompletion: vi.fn(async () => ({
      status: 200,
      body: { id: 'r', object: 'chat.completion', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      usage: { promptTokens: 1, completionTokens: 1, totalCost: null },
      providerCostUsd: null,
    })),
  };
}

function failingAdapter(): RouterAdapter {
  return {
    name: 'unused' as any,
    toUpstreamId: () => 'm',
    listModels: vi.fn(async () => []),
    chatCompletion: vi.fn(async () => {
      throw new AdapterError('provider-secondary' as any, 502, 'transport', 'boom');
    }),
  };
}

// Two-router catalog: openrouter is cheaper (ranker prefers it), provider-secondary is the
// alternative pinned candidate.
function twoRouterEntry() {
  return entryMulti(
    { name: 'openrouter', pp: 0.1, cp: 0.1 },
    { name: 'provider-secondary', pp: 10, cp: 10 },
  );
}

function singleRouterEntry(name: string) {
  return entryMulti({ name, pp: 1, cp: 1 });
}

const baseReq: ChatCompletionRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any;

describe('chat sticky routing', () => {
  it('routes to the bound router when session_id is set', async () => {
    const kvSpy = makeKvSpy();
    await kvSpy.bindings.set(sessionKey('s1'), 'provider-secondary' as any, 300);

    const er = okAdapter();
    const or = okAdapter();
    const adapters = new Map<string, RouterAdapter>([
      ['openrouter', or],
      ['provider-secondary', er],
    ]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(twoRouterEntry(), [
        { name: 'openrouter', enabled: true },
        { name: 'provider-secondary', enabled: true },
      ]),
      adapters,
      stickyBindings: kvSpy.bindings,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    await routeChatCompletion(ctx as any, { ...baseReq, session_id: 's1' } as any);

    expect(er.chatCompletion).toHaveBeenCalledTimes(1);
    expect(or.chatCompletion).not.toHaveBeenCalled();
  });

  it('falls back to prefix-hash binding when no session_id', async () => {
    const kvSpy = makeKvSpy();
    const req = { ...baseReq, cache_control: { type: 'ephemeral' as const } };
    const hash = hashCacheablePrefix(req as any);
    await kvSpy.bindings.set(prefixKey(hash), 'openrouter' as any, 300);

    const er = okAdapter();
    const or = okAdapter();
    const adapters = new Map<string, RouterAdapter>([
      ['openrouter', or],
      ['provider-secondary', er],
    ]);

    // Make provider-secondary the ranker's top pick by making it cheaper, so the pin to
    // openrouter is observable (i.e., we're not just getting it for free).
    const entry = entryMulti(
      { name: 'openrouter', pp: 10, cp: 10 },
      { name: 'provider-secondary', pp: 0.1, cp: 0.1 },
    );

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(entry, [
        { name: 'openrouter', enabled: true },
        { name: 'provider-secondary', enabled: true },
      ]),
      adapters,
      stickyBindings: kvSpy.bindings,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    await routeChatCompletion(ctx as any, req as any);

    expect(or.chatCompletion).toHaveBeenCalledTimes(1);
    expect(er.chatCompletion).not.toHaveBeenCalled();
  });

  it('falls through to normal ranking when no binding exists', async () => {
    const kvSpy = makeKvSpy();
    // Single eligible router so the ranker's pick is deterministic.
    const or = okAdapter();
    const adapters = new Map<string, RouterAdapter>([['openrouter', or]]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(singleRouterEntry('openrouter'), [{ name: 'openrouter', enabled: true }]),
      adapters,
      stickyBindings: kvSpy.bindings,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    await routeChatCompletion(ctx as any, { ...baseReq, session_id: 's-unbound' } as any);

    expect(or.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('writes a binding after a successful call', async () => {
    const kvSpy = makeKvSpy();
    const or = okAdapter();
    const adapters = new Map<string, RouterAdapter>([['openrouter', or]]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(singleRouterEntry('openrouter'), [{ name: 'openrouter', enabled: true }]),
      adapters,
      stickyBindings: kvSpy.bindings,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    await routeChatCompletion(ctx as any, {
      ...baseReq,
      session_id: 's-new',
      cache_control: { type: 'ephemeral' as const },
    } as any);

    expect(await kvSpy.bindings.get(sessionKey('s-new'))).toBe('openrouter');
  });

  it('deletes the binding and falls over on pinned-router 5xx', async () => {
    const kvSpy = makeKvSpy();
    await kvSpy.bindings.set(sessionKey('s-fail'), 'provider-secondary' as any, 300);

    const er = failingAdapter();
    const or = okAdapter();
    const adapters = new Map<string, RouterAdapter>([
      ['openrouter', or],
      ['provider-secondary', er],
    ]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(twoRouterEntry(), [
        { name: 'openrouter', enabled: true },
        { name: 'provider-secondary', enabled: true },
      ]),
      adapters,
      stickyBindings: kvSpy.bindings,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    const result = await routeChatCompletion(ctx as any, { ...baseReq, session_id: 's-fail' } as any);

    expect(result.status).toBe(200);
    // provider-secondary was tried first (pinned), then openrouter as fallback.
    expect(er.chatCompletion).toHaveBeenCalledTimes(1);
    expect(or.chatCompletion).toHaveBeenCalledTimes(1);
    // Binding for the failed pin must have been deleted before fallback wrote a fresh one.
    // After the fallback succeeded on openrouter, a new binding is written pointing to openrouter.
    expect(await kvSpy.bindings.get(sessionKey('s-fail'))).toBe('openrouter');
  });

  it('respects 1h ttl on the written binding', async () => {
    const kvSpy = makeKvSpy();
    const or = okAdapter();
    const adapters = new Map<string, RouterAdapter>([['openrouter', or]]);

    const ctx = {
      platformPool: makePoolStub(),
      runtimePool: makePoolStub(),
      redis: makeRedis(singleRouterEntry('openrouter'), [{ name: 'openrouter', enabled: true }]),
      adapters,
      stickyBindings: kvSpy.bindings,
      markupPct: 0, appId: 'a', userId: 'u', region: 'r',
    };

    await routeChatCompletion(ctx as any, {
      ...baseReq,
      session_id: 's-1h',
      cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
    } as any);

    expect(kvSpy.lastTtl).toBe(3600);
  });
});
