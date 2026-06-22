/**
 * End-to-end integration test for the unified caching flow (Tasks 1-13).
 *
 * Exercises the full pipeline at the routeChatCompletion() level:
 *   - session_id + cache_control on system content triggers sticky binding
 *   - Call 1: adapter returns cache_creation_input_tokens → usage spy captures it
 *   - Call 2: adapter returns cache_read_input_tokens → sticky pin stays the same router
 *   - Fallback billing (providerCostUsd = null) applies 0-cost discount on cached tokens
 *
 * Usage assertions: spies on writeAiUsageRow (same pattern as router.sticky.test.ts —
 * no real DB needed). Billing assertions: capture the chargedCreditsUsd argument passed
 * to writeAiUsageRow and compare across calls.
 *
 * Catalog setup: synthetic Redis mock (same pattern as router.sticky.test.ts) — does NOT
 * rely on live catalog refresh.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { routeChatCompletion } from './router.js';
import { createStickyBindings, sessionKey, type KVClient } from './sticky-bindings.js';
import { type RouterAdapter, type ChatCompletionRequest } from './adapters/types.js';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('./billing-gate.js', () => ({
  acquireForEstimatedCost: vi.fn(async () => ({
    leaseId: 'lease-e2e',
    amountGrantedUsd: 1,
    expiresAt: new Date(),
  })),
  settleAfterCall: vi.fn(async () => ({ refundedUsd: 0 })),
  leaseTtlSeconds: vi.fn(() => 60),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

// Spy on writeAiUsageRow so we can assert usage-log args without a real DB.
const writeAiUsageRowMock = vi.fn(async () => {});
vi.mock('./usage-log.js', () => ({
  writeAiUsageRow: (...args: unknown[]) => writeAiUsageRowMock(...args),
}));

vi.mock('../auto-refill-service.js', () => ({
  maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()),
}));

// credits-email — non-fatal, fire-and-forget; stub so it doesn't throw.
vi.mock('../credits-email.js', () => ({
  maybeSendCreditsEmail: vi.fn(() => Promise.resolve()),
}));
vi.mock('../auth/email-service.js', () => ({
  sendBillingEmail: vi.fn(() => Promise.resolve()),
}));

// audit-events — only emitted on InsufficientCreditsError, not in scope here.
vi.mock('../audit/audit-events-service.js', () => ({
  logAuditEvent: vi.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKvSpy() {
  const store = new Map<string, string>();
  const kv: KVClient = {
    async get(key) { return store.has(key) ? store.get(key)! : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
  return { kv, bindings: createStickyBindings(kv), store };
}

function makePoolStub() {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [{ user_id: 'u', credits_usd: '100', amount_usd: '100', status: 'active' }] })),
      release: vi.fn(),
    })),
    query: vi.fn(async () => ({ rows: [{ monthly_allowance_usd: '10', credits_usd: '100' }] })),
  } as any;
}

function makeRedis(catalogEntry: any, routers: any[]) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:claude-3-5-sonnet') return JSON.stringify(catalogEntry);
      if (key === 'ai_catalog:routers') return JSON.stringify(routers);
      return null;
    }),
  } as any;
}

/**
 * Synthetic single-router catalog entry for claude-3-5-sonnet routed through
 * 'provider-primary'. Prices: $3/$15 per Mtok (Anthropic public pricing).
 */
function singleRouterEntry() {
  return {
    canonicalId: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    updatedAt: new Date().toISOString(),
    routers: [
      {
        name: 'provider-primary',
        upstreamId: 'claude-3-5-sonnet-20241022',
        promptPricePerMtok: 3.0,
        completionPricePerMtok: 15.0,
        contextLength: 200000,
      },
    ],
  };
}

/**
 * Build a RouterAdapter mock whose chatCompletion resolves with the given
 * cache-token usage shape. providerCostUsd = null to exercise the fallback
 * billing path (Task 13).
 */
function makeAdapter(usage: {
  promptTokens: number;
  completionTokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): RouterAdapter {
  return {
    name: 'provider-primary' as any,
    toUpstreamId: () => 'claude-3-5-sonnet-20241022',
    listModels: vi.fn(async () => []),
    chatCompletion: vi.fn(async () => ({
      status: 200,
      body: {
        id: 'msg_test',
        object: 'chat.completion',
        model: 'claude-3-5-sonnet-20241022',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        },
      },
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalCost: null,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      },
      // null → force fallback billing path (Task 13)
      providerCostUsd: null,
    })),
  };
}

const SESSION_ID = 'test-session-e2e-001';

const systemMessage = {
  role: 'system' as const,
  content: 'You are a helpful assistant.',
  // cache_control is passed as a content-level field when the body-level
  // cache_control is ephemeral; both paths land in the same sticky-binding logic.
};

const baseMessages = [
  systemMessage,
  { role: 'user' as const, content: 'What is the capital of France?' },
];

const cacheReq: ChatCompletionRequest = {
  model: 'claude-3-5-sonnet',
  messages: baseMessages,
  session_id: SESSION_ID,
  cache_control: { type: 'ephemeral' },
} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cache e2e: sticky routing + usage-log + fallback billing', () => {
  let kvSpy: ReturnType<typeof makeKvSpy>;
  let platformPool: any;
  let runtimePool: any;
  let redis: any;

  beforeEach(() => {
    writeAiUsageRowMock.mockClear();
    kvSpy = makeKvSpy();
    platformPool = makePoolStub();
    runtimePool = makePoolStub();
    redis = makeRedis(singleRouterEntry(), [{ name: 'provider-primary', enabled: true }]);
  });

  it('call 1: routes successfully and records cache_creation_input_tokens', async () => {
    const adapter = makeAdapter({
      promptTokens: 15000,
      completionTokens: 100,
      cache_creation_input_tokens: 10000,
    });
    const adapters = new Map([['provider-primary', adapter]]);

    const result = await routeChatCompletion(
      { platformPool, runtimePool, redis, adapters, stickyBindings: kvSpy.bindings, markupPct: 0, appId: 'app-e2e', userId: 'u-e2e', region: 'us-east-1' } as any,
      cacheReq,
    );

    // Router returns the chosen provider name
    expect(result.status).toBe(200);
    expect(result.chosen).toBe('provider-primary');

    // Sticky binding was written for this session
    const bound = await kvSpy.bindings.get(sessionKey(SESSION_ID));
    expect(bound).toBe('provider-primary');

    // usage-log spy was called with cache_creation_input_tokens = 10000
    expect(writeAiUsageRowMock).toHaveBeenCalledTimes(1);
    const usageArg = writeAiUsageRowMock.mock.calls[0][1] as any;
    expect(usageArg.cacheCreationInputTokens).toBe(10000);
    expect(usageArg.cacheReadInputTokens).toBe(0);
    expect(usageArg.router).toBe('provider-primary');
    expect(usageArg.model).toBe('claude-3-5-sonnet');
  });

  it('call 2: sticky pin holds and records cache_read_input_tokens', async () => {
    // Pre-seed the session binding (simulating call 1 having already run).
    await kvSpy.bindings.set(sessionKey(SESSION_ID), 'provider-primary' as any, 3600);

    const adapter = makeAdapter({
      promptTokens: 5000,
      completionTokens: 100,
      cache_read_input_tokens: 10000,
    });
    const adapters = new Map([['provider-primary', adapter]]);

    const result = await routeChatCompletion(
      { platformPool, runtimePool, redis, adapters, stickyBindings: kvSpy.bindings, markupPct: 0, appId: 'app-e2e', userId: 'u-e2e', region: 'us-east-1' } as any,
      cacheReq,
    );

    expect(result.status).toBe(200);
    // Same router as call 1 — sticky binding held
    expect(result.chosen).toBe('provider-primary');

    expect(writeAiUsageRowMock).toHaveBeenCalledTimes(1);
    const usageArg = writeAiUsageRowMock.mock.calls[0][1] as any;
    expect(usageArg.cacheReadInputTokens).toBe(10000);
    expect(usageArg.cacheCreationInputTokens).toBe(0);
  });

  it('fallback billing: cache-read call costs less than a full-price call', async () => {
    // --- Full-price call (no cache) ---
    const adapterNoCache = makeAdapter({
      promptTokens: 15000,
      completionTokens: 100,
      // no cache fields → treated as 0
    });
    await routeChatCompletion(
      {
        platformPool: makePoolStub(), runtimePool: makePoolStub(),
        redis: makeRedis(singleRouterEntry(), [{ name: 'provider-primary', enabled: true }]),
        adapters: new Map([['provider-primary', adapterNoCache]]),
        stickyBindings: makeKvSpy().bindings,
        markupPct: 0, appId: 'app-e2e', userId: 'u-e2e', region: 'us-east-1',
      } as any,
      { ...cacheReq, session_id: 'session-no-cache' } as any,
    );
    const chargedNoCache = (writeAiUsageRowMock.mock.calls[0][1] as any).chargedCreditsUsd as number;

    writeAiUsageRowMock.mockClear();

    // --- Cache-read call (same prompt tokens, but 10000 served from cache) ---
    const adapterWithCache = makeAdapter({
      promptTokens: 15000,
      completionTokens: 100,
      cache_read_input_tokens: 10000,
    });
    await routeChatCompletion(
      {
        platformPool: makePoolStub(), runtimePool: makePoolStub(),
        redis: makeRedis(singleRouterEntry(), [{ name: 'provider-primary', enabled: true }]),
        adapters: new Map([['provider-primary', adapterWithCache]]),
        stickyBindings: makeKvSpy().bindings,
        markupPct: 0, appId: 'app-e2e', userId: 'u-e2e', region: 'us-east-1',
      } as any,
      { ...cacheReq, session_id: 'session-cache-hit' } as any,
    );
    const chargedWithCache = (writeAiUsageRowMock.mock.calls[0][1] as any).chargedCreditsUsd as number;

    // Cache-read call must be cheaper than the un-cached call (Task 13: 10k cached
    // tokens are billed at $0 in the fallback estimator, saving ~$0.03 at $3/Mtok).
    expect(chargedWithCache).toBeLessThan(chargedNoCache);
  });

  it('two sequential calls bind and stay on the same router', async () => {
    const adapter1 = makeAdapter({ promptTokens: 12000, completionTokens: 80, cache_creation_input_tokens: 10000 });
    const adapter2 = makeAdapter({ promptTokens: 5000, completionTokens: 80, cache_read_input_tokens: 10000 });

    // Call 1
    const r1 = await routeChatCompletion(
      { platformPool, runtimePool, redis, adapters: new Map([['provider-primary', adapter1]]), stickyBindings: kvSpy.bindings, markupPct: 0, appId: 'app-e2e', userId: 'u-e2e', region: 'us-east-1' } as any,
      cacheReq,
    );
    const router1 = r1.chosen!;

    // Replace adapter with call-2 mock (same router name, different usage shape)
    const adapters2 = new Map([['provider-primary', adapter2]]);

    // Call 2 — same session_id; must be routed to the same router
    const r2 = await routeChatCompletion(
      { platformPool, runtimePool, redis, adapters: adapters2, stickyBindings: kvSpy.bindings, markupPct: 0, appId: 'app-e2e', userId: 'u-e2e', region: 'us-east-1' } as any,
      cacheReq,
    );
    const router2 = r2.chosen!;

    expect(router1).toBe('provider-primary');
    expect(router2).toBe(router1); // sticky: same router across turns

    // Verify usage rows differ correctly
    expect(writeAiUsageRowMock).toHaveBeenCalledTimes(2);
    const row1 = writeAiUsageRowMock.mock.calls[0][1] as any;
    const row2 = writeAiUsageRowMock.mock.calls[1][1] as any;

    expect(row1.cacheCreationInputTokens).toBe(10000);
    expect(row1.cacheReadInputTokens).toBe(0);

    expect(row2.cacheReadInputTokens).toBe(10000);
    expect(row2.cacheCreationInputTokens).toBe(0);

    // Call 2 should cost less (cache-read discount via fallback estimator)
    expect(row2.chargedCreditsUsd).toBeLessThan(row1.chargedCreditsUsd);
  });
});
