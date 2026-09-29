import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeDecision, routeChatCompletion, routeEmbedding, RouterError, DECISION_HOLD_TOKEN_MULTIPLIER, DECISION_HOLD_TOKENS_PER_QUESTION } from './router.js';
import { AdapterError, type RouterAdapter } from './adapters/types.js';
import { applyMarkup } from './markup.js';
import { estimatePromptTokens } from './tokenizer.js';
import { estimateWorstCaseUsd } from './select.js';
import { settleAfterCall, acquireForEstimatedCost } from './billing-gate.js';
import { writeAiUsageRow } from './usage-log.js';

vi.mock('./billing-gate.js', () => ({
  acquireForEstimatedCost: vi.fn(async () => ({ leaseId: 'lease-1', amountGrantedUsd: 1, expiresAt: new Date() })),
  settleAfterCall: vi.fn(async () => ({ refundedUsd: 0 })),
  leaseTtlSeconds: vi.fn(() => 60),
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
vi.mock('./usage-log.js', () => ({ writeAiUsageRow: vi.fn(async () => {}) }));
vi.mock('../auto-refill-service.js', () => ({ maybeTriggerAutoRefill: vi.fn(() => Promise.resolve()) }));

const ROUTERS = [{ name: 'openrouter', enabled: true, lastRefreshAt: '', lastRefreshStatus: 'ok' }];

function decisionsEntry(modality: 'decisions' | 'chat' = 'decisions') {
  return {
    canonicalId: 'm', displayName: 'm', updatedAt: new Date().toISOString(),
    routers: [{ name: 'openrouter', upstreamId: 'm', promptPricePerMtok: 0.042, completionPricePerMtok: 0, contextLength: 32000, modality }],
  };
}

function makeRedis(entry: unknown) {
  return {
    get: vi.fn(async (key: string) => {
      if (key === 'ai_catalog:model:m') return entry ? JSON.stringify(entry) : null;
      if (key === 'ai_catalog:routers') return JSON.stringify(ROUTERS);
      return null;
    }),
  } as any;
}

function pool() {
  return {
    connect: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })),
    query: vi.fn(async () => ({ rows: [] })),
  } as any;
}

function ctx(entry: unknown, adapter: Partial<RouterAdapter>) {
  return {
    platformPool: pool(), runtimePool: pool(), redis: makeRedis(entry),
    adapters: new Map([['openrouter', { name: 'openrouter', toUpstreamId: (x: string) => x, ...adapter } as RouterAdapter]]),
    markupPct: 20, markupSource: 'global', appId: 'app_1', organizationId: 'org_1', userId: 'u', region: 'r',
  } as any;
}

const REQ = { model: 'm', state: { ticket: 'blank checkout' }, questions: { is_bug: { type: 'noul', instructions: 'bug?', criteria: { true: 'y', false: 'n' } } } };

function okResult(cost: number | null, inputTokens = 476) {
  return {
    status: 200,
    body: { id: 'gen-dec-1', answers: { is_bug: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: inputTokens, output_tokens: 70, ...(cost !== null ? { cost } : {}) } },
    usage: { promptTokens: inputTokens, completionTokens: 70, totalCost: cost },
    providerCostUsd: cost,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('routeDecision', () => {
  it('404 MODEL_NOT_FOUND for an unknown model', async () => {
    await expect(routeDecision(ctx(null, {}), REQ)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', statusCode: 404 });
  });

  it('400 WRONG_MODALITY when the model is a chat model', async () => {
    await expect(routeDecision(ctx(decisionsEntry('chat'), {}), REQ)).rejects.toMatchObject({ code: 'WRONG_MODALITY', statusCode: 400 });
  });

  it('settles on upstream usage.cost x markup and rewrites usage.cost in the body', async () => {
    const decisions = vi.fn(async () => okResult(0.00002));
    const r = await routeDecision(ctx(decisionsEntry(), { decisions }), REQ);
    const charged = applyMarkup(0.00002, 20);
    expect(settleAfterCall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leaseId: 'lease-1' }), charged);
    expect((r.body as any).usage.cost).toBeCloseTo(charged, 12);
    expect((r.body as any).usage.input_tokens).toBe(476);
    expect((r.body as any).answers.is_bug.noul).toBe(0.9);
  });

  it('falls back to reported input_tokens x catalog price when usage.cost is absent', async () => {
    const decisions = vi.fn(async () => okResult(null, 1_000_000));
    await routeDecision(ctx(decisionsEntry(), { decisions }), REQ);
    // 1M tokens x $0.042/Mtok = $0.042, x 1.2 markup
    expect(settleAfterCall).toHaveBeenCalledWith(expect.anything(), expect.anything(), applyMarkup(0.042, 20));
  });

  it('writes a usage row with modality=decisions and reported tokens', async () => {
    await routeDecision(ctx(decisionsEntry(), { decisions: vi.fn(async () => okResult(0.00002)) }), REQ);
    expect(writeAiUsageRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      modality: 'decisions', promptTokens: 476, completionTokens: 70, model: 'm', router: 'openrouter',
    }));
  });

  it('forwards the request body verbatim with the upstream id', async () => {
    const decisions = vi.fn(async () => okResult(0.00002));
    await routeDecision(ctx(decisionsEntry(), { decisions }), REQ);
    expect(decisions).toHaveBeenCalledWith(REQ, 'm');
  });

  // OpenRouter's Decisions API rejects a body without `state` ("state: Invalid
  // input"), verified live 2026-09-29; `{}` is accepted.
  it('defaults a missing state to {} before calling upstream', async () => {
    const decisions = vi.fn(async () => okResult(0.00002));
    const { state: _omit, ...noState } = REQ;
    await routeDecision(ctx(decisionsEntry(), { decisions }), noState as typeof REQ);
    expect(decisions).toHaveBeenCalledWith({ ...noState, state: {} }, 'm');
  });

  it('passes an explicit falsy state (empty string) through unchanged', async () => {
    const decisions = vi.fn(async () => okResult(0.00002));
    await routeDecision(ctx(decisionsEntry(), { decisions }), { ...REQ, state: '' });
    expect(decisions).toHaveBeenCalledWith({ ...REQ, state: '' }, 'm');
  });

  it('releases the lease and rethrows a non-fallback upstream 400', async () => {
    const decisions = vi.fn(async () => { throw new AdapterError('openrouter', 400, 'bad_request', '{"error":{"message":"bad criteria"}}'); });
    await expect(routeDecision(ctx(decisionsEntry(), { decisions }), REQ)).rejects.toMatchObject({ kind: 'bad_request' });
    expect(settleAfterCall).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0);
  });

  it('ROUTER_FALLBACK_EXHAUSTED when the only adapter has no decisions()', async () => {
    await expect(routeDecision(ctx(decisionsEntry(), {}), REQ)).rejects.toMatchObject({ code: 'ROUTER_FALLBACK_EXHAUSTED' });
  });
});

describe('decision models on chat and embedding routes', () => {
  it('routeChatCompletion rejects a decisions-only model with WRONG_MODALITY', async () => {
    await expect(routeChatCompletion(ctx(decisionsEntry(), {}), { model: 'm', messages: [{ role: 'user', content: 'hi' }] } as any))
      .rejects.toMatchObject({ code: 'WRONG_MODALITY', statusCode: 400 });
  });
  it('routeEmbedding rejects a decisions-only model with WRONG_MODALITY', async () => {
    await expect(routeEmbedding(ctx(decisionsEntry(), {}), { model: 'm', input: 'hi' } as any))
      .rejects.toMatchObject({ code: 'WRONG_MODALITY', statusCode: 400 });
  });
});

describe('routeDecision billing step 3 and edge paths', () => {
  const estimateCharged = () => {
    const tokens = estimatePromptTokens([{ role: 'user', content: JSON.stringify({ state: REQ.state ?? null, questions: REQ.questions }) }], 'm');
    return applyMarkup(estimateWorstCaseUsd({ promptPricePerMtok: 0.042, completionPricePerMtok: 0 } as any, tokens, 0, 0, 0), 20);
  };

  it('bills the estimate when usage is absent and cost is null', async () => {
    const decisions = vi.fn(async () => ({ status: 200, body: { answers: {} }, usage: undefined, providerCostUsd: null }));
    await routeDecision(ctx(decisionsEntry(), { decisions: decisions as any }), REQ);
    const charged = (settleAfterCall as any).mock.calls[0][2];
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeCloseTo(estimateCharged(), 12);
    expect(writeAiUsageRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chargedCreditsUsd: charged }));
  });

  it('bills the estimate when usage reports 0 prompt tokens and cost is null', async () => {
    const decisions = vi.fn(async () => ({
      status: 200, body: { answers: {}, usage: { output_tokens: 70 } },
      usage: { promptTokens: 0, completionTokens: 70, totalCost: null }, providerCostUsd: null,
    }));
    await routeDecision(ctx(decisionsEntry(), { decisions }), REQ);
    const charged = (settleAfterCall as any).mock.calls[0][2];
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeCloseTo(estimateCharged(), 12);
    expect(writeAiUsageRow).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ chargedCreditsUsd: charged, promptTokens: expect.any(Number) }));
    expect((writeAiUsageRow as any).mock.calls[0][1].promptTokens).toBeGreaterThan(0);
  });

  it('falls back to the second router on a rate_limit error', async () => {
    const entry = decisionsEntry();
    entry.routers.push({ ...entry.routers[0], name: 'provider-primary' } as any);
    const routers = [
      { name: 'openrouter', enabled: true, lastRefreshAt: '', lastRefreshStatus: 'ok' },
      { name: 'provider-primary', enabled: true, lastRefreshAt: '', lastRefreshStatus: 'ok' },
    ];
    const c = ctx(entry, {});
    c.redis.get = vi.fn(async (key: string) => key === 'ai_catalog:model:m' ? JSON.stringify(entry) : key === 'ai_catalog:routers' ? JSON.stringify(routers) : null);
    const first = vi.fn(async () => { throw new AdapterError('openrouter', 429, 'rate_limit', 'slow'); });
    const second = vi.fn(async () => okResult(0.00002));
    c.adapters = new Map([
      ['openrouter', { name: 'openrouter', toUpstreamId: (x: string) => x, decisions: first }],
      ['provider-primary', { name: 'provider-primary', toUpstreamId: (x: string) => x, decisions: second }],
    ]);
    const r = await routeDecision(c, REQ);
    expect(r.status).toBe(200);
    // ranking order is not asserted; at least one adapter served the call and success settled > 0
    expect(second).toHaveBeenCalled();
    expect((settleAfterCall as any).mock.calls[0][2]).toBeGreaterThan(0);
  });

  it('NO_ROUTERS_AVAILABLE when the only router is disabled', async () => {
    const c = ctx(decisionsEntry(), { decisions: vi.fn() });
    c.redis.get = vi.fn(async (key: string) => key === 'ai_catalog:model:m' ? JSON.stringify(decisionsEntry())
      : key === 'ai_catalog:routers' ? JSON.stringify([{ ...ROUTERS[0], enabled: false }]) : null);
    await expect(routeDecision(c, REQ)).rejects.toMatchObject({ code: 'NO_ROUTERS_AVAILABLE' });
  });

  it('returns a body without usage, and a non-object body, unchanged', async () => {
    const noUsage = { answers: { a: 1 } };
    const r1 = await routeDecision(ctx(decisionsEntry(), { decisions: vi.fn(async () => ({ status: 200, body: noUsage, usage: { promptTokens: 10, completionTokens: 1, totalCost: null }, providerCostUsd: 0.001 })) as any }), REQ);
    expect(r1.body).toBe(noUsage);
    const r2 = await routeDecision(ctx(decisionsEntry(), { decisions: vi.fn(async () => ({ status: 200, body: 'plain', usage: { promptTokens: 10, completionTokens: 1, totalCost: null }, providerCostUsd: 0.001 })) as any }), REQ);
    expect(r2.body).toBe('plain');
  });
});

describe('routeDecision credit hold', () => {
  it('pads the hold for per-question scaffolding so it covers an observed 476-token call', async () => {
    const decisions = vi.fn(async () => okResult(0.00002));
    await routeDecision(ctx(decisionsEntry(), { decisions }), REQ);
    const reserved = (acquireForEstimatedCost as any).mock.calls[0][4];
    const estimated = estimatePromptTokens([{ role: 'user', content: JSON.stringify({ state: REQ.state ?? null, questions: REQ.questions }) }], 'm');
    const holdTokens = estimated * DECISION_HOLD_TOKEN_MULTIPLIER + DECISION_HOLD_TOKENS_PER_QUESTION * Object.keys(REQ.questions).length;
    expect(DECISION_HOLD_TOKEN_MULTIPLIER).toBe(2);
    expect(DECISION_HOLD_TOKENS_PER_QUESTION).toBe(500);
    expect(reserved).toBeCloseTo((holdTokens / 1_000_000) * 0.042 * 1.2, 15);
    expect(reserved).toBeGreaterThanOrEqual(applyMarkup((476 / 1_000_000) * 0.042, 20));
  });
});
