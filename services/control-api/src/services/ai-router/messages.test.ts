import { describe, it, expect, vi } from 'vitest';
import { routeMessages } from './messages.js';

vi.mock('./router.js', async (orig) => {
  const real = await orig<typeof import('./router.js')>();
  return { ...real, routeChatCompletion: vi.fn() };
});
const { routeChatCompletion } = await import('./router.js');

vi.mock('./catalog.js', () => ({ readCatalogEntry: vi.fn() }));
vi.mock('./select.js', () => ({
  rankRoutersForModel: vi.fn(),
  estimateWorstCaseUsd: vi.fn().mockReturnValue(0.001),
}));
vi.mock('./tokenizer.js', () => ({ estimatePromptTokens: vi.fn().mockReturnValue(10) }));
vi.mock('./billing-gate.js', () => ({
  acquireForEstimatedCost: vi.fn().mockResolvedValue({ leaseId: 'lease-1', amountGrantedUsd: 0.01, expiresAt: new Date() }),
  settleAfterCall: vi.fn().mockResolvedValue({ refundedUsd: 0 }),
  leaseTtlSeconds: vi.fn().mockReturnValue(60),
}));
vi.mock('./usage-log.js', () => ({ writeAiUsageRow: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./markup.js', () => ({ applyMarkup: vi.fn().mockImplementation((cost: number, pct: number) => cost * (1 + pct / 100)) }));
vi.mock('../auto-refill-service.js', () => ({ maybeTriggerAutoRefill: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../credits-email.js', () => ({ maybySendCreditsEmail: vi.fn().mockResolvedValue(undefined) }));

const { readCatalogEntry } = await import('./catalog.js');
const { rankRoutersForModel } = await import('./select.js');

describe('routeMessages (non-streaming, translated)', () => {
  it('translates request, calls routeChatCompletion, translates response', async () => {
    (routeChatCompletion as any).mockResolvedValue({
      status: 200, chosen: 'openrouter',
      body: { id: 'cc_x', choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 1 } },
    });
    const result = await routeMessages(
      { adapters: new Map([['openrouter', { name: 'openrouter', capabilities: { supportsNativeMessages: () => false } } as any]]) } as any,
      { model: 'anthropic/claude-3.5-sonnet', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      {},
    );
    expect(result.status).toBe(200);
    expect((result.body as any).type).toBe('message');
    expect((result.body as any).content[0]).toEqual({ type: 'text', text: 'hi' });
  });
});

describe('routeMessages (native passthrough)', () => {
  it('calls adapter.nativeMessages and forwards body', async () => {
    vi.mocked(readCatalogEntry).mockResolvedValue({
      canonicalId: 'anthropic/claude-opus-4.8',
      routers: [{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }],
    } as any);
    vi.mocked(rankRoutersForModel).mockReturnValue([{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }] as any);

    const native = vi.fn().mockResolvedValue({
      status: 200,
      body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'anthropic/claude-opus-4.8',
              content: [{ type: 'text', text: 'native hi' }], stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 2 } },
      usage: { promptTokens: 3, completionTokens: 2, totalCost: null },
      providerCostUsd: null,
    });
    const adapters = new Map<string, any>([
      ['provider-secondary', {
        name: 'provider-secondary',
        capabilities: { supportsNativeMessages: (id: string) => id.startsWith('anthropic/') },
        toUpstreamId: (id: string) => id, nativeMessages: native,
      }],
    ]);

    const result = await routeMessages(
      {
        adapters, redis: {} as any,
        platformPool: {} as any, runtimePool: {} as any,
        markupPct: 0, appId: 'app-1', userId: 'user-1', region: 'us-east-1',
      } as any,
      { model: 'anthropic/claude-opus-4.8', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { anthropicVersion: '2023-06-01' },
    );
    expect(native).toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect((result.body as any).content[0]).toEqual({ type: 'text', text: 'native hi' });
  });
});

describe('routeMessages (native passthrough, non-streaming)', () => {
  it('acquires lease, settles, and writes usage row after native call', async () => {
    vi.mocked(readCatalogEntry).mockResolvedValue({
      canonicalId: 'anthropic/claude-opus-4.8',
      routers: [{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }],
    } as any);
    vi.mocked(rankRoutersForModel).mockReturnValue([
      { name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }
    ] as any);

    const native = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-4.8',
        content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 }
      },
      usage: { promptTokens: 5, completionTokens: 3, totalCost: null },
      providerCostUsd: null,
    });
    const adapters = new Map<string, any>([
      ['provider-secondary', {
        name: 'provider-secondary',
        capabilities: { supportsNativeMessages: () => true },
        toUpstreamId: (id: string) => id,
        nativeMessages: native,
      }],
    ]);

    const { writeAiUsageRow } = await import('./usage-log.js');
    const { settleAfterCall } = await import('./billing-gate.js');

    await routeMessages(
      {
        adapters, redis: {} as any,
        platformPool: {} as any, runtimePool: {} as any,
        markupPct: 0, appId: 'app-1', userId: 'user-1', region: 'us-east-1',
      } as any,
      { model: 'anthropic/claude-opus-4.8', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { anthropicVersion: '2023-06-01' },
    );

    expect(writeAiUsageRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promptTokens: 5, completionTokens: 3 }),
    );
    expect(settleAfterCall).toHaveBeenCalled();
  });
});

describe('routeMessages (native passthrough, non-streaming, error path)', () => {
  it('settles with 0 credits when adapter.nativeMessages rejects', async () => {
    vi.mocked(readCatalogEntry).mockResolvedValue({
      canonicalId: 'anthropic/claude-opus-4.8',
      routers: [{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }],
    } as any);
    vi.mocked(rankRoutersForModel).mockReturnValue([
      { name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }
    ] as any);

    const native = vi.fn().mockRejectedValue(new Error('upstream timeout'));
    const adapters = new Map<string, any>([
      ['provider-secondary', {
        name: 'provider-secondary',
        capabilities: { supportsNativeMessages: () => true },
        toUpstreamId: (id: string) => id,
        nativeMessages: native,
      }],
    ]);

    const { settleAfterCall } = await import('./billing-gate.js');
    vi.mocked(settleAfterCall).mockClear();

    await expect(routeMessages(
      {
        adapters, redis: {} as any,
        platformPool: {} as any, runtimePool: {} as any,
        markupPct: 0, appId: 'app-1', userId: 'user-1', region: 'us-east-1',
      } as any,
      { model: 'anthropic/claude-opus-4.8', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
      { anthropicVersion: '2023-06-01' },
    )).rejects.toThrow('upstream timeout');

    expect(settleAfterCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      0,
    );
  });
});

describe('routeMessages (native passthrough, streaming)', () => {
  it('settles lease and writes usage row after draining stream', async () => {
    vi.mocked(readCatalogEntry).mockResolvedValue({
      canonicalId: 'anthropic/claude-opus-4.8',
      routers: [{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }],
    } as any);
    vi.mocked(rankRoutersForModel).mockReturnValue([
      { name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }
    ] as any);

    // Build a minimal Anthropic SSE stream
    const enc = new TextEncoder();
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].map(s => enc.encode(s));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of events) controller.enqueue(chunk);
        controller.close();
      },
    });

    const native = vi.fn().mockResolvedValue({ status: 200, stream });
    const adapters = new Map<string, any>([
      ['provider-secondary', {
        name: 'provider-secondary',
        capabilities: { supportsNativeMessages: () => true },
        toUpstreamId: (id: string) => id,
        nativeMessages: native,
      }],
    ]);

    const { writeAiUsageRow } = await import('./usage-log.js');
    const { settleAfterCall } = await import('./billing-gate.js');

    const result = await routeMessages(
      {
        adapters, redis: {} as any,
        platformPool: {} as any, runtimePool: {} as any,
        markupPct: 0, appId: 'app-1', userId: 'user-1', region: 'us-east-1',
      } as any,
      { model: 'anthropic/claude-opus-4.8', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], stream: true },
      { anthropicVersion: '2023-06-01' },
    );

    // Drain the stream to trigger settlement
    expect(result.stream).toBeDefined();
    const reader = result.stream!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    expect(settleAfterCall).toHaveBeenCalled();
    expect(writeAiUsageRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promptTokens: 10, completionTokens: 5 }),
    );
  });
});

describe('routeMessages (native passthrough, streaming, thinking tokens)', () => {
  it('accumulates thinking_delta text and writes reasoningTokens to usage row', async () => {
    vi.mocked(readCatalogEntry).mockResolvedValue({
      canonicalId: 'anthropic/claude-opus-4.8',
      routers: [{ name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }],
    } as any);
    vi.mocked(rankRoutersForModel).mockReturnValue([
      { name: 'provider-secondary', upstreamId: 'anthropic.claude-opus-4-8', promptPricePerMtok: 3, completionPricePerMtok: 15, contextLength: 200000 }
    ] as any);

    // Build a stream that includes thinking_delta events followed by normal text.
    const enc = new TextEncoder();
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me reason about this."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].map(s => enc.encode(s));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of events) controller.enqueue(chunk);
        controller.close();
      },
    });

    const native = vi.fn().mockResolvedValue({ status: 200, stream });
    const adapters = new Map<string, any>([
      ['provider-secondary', {
        name: 'provider-secondary',
        capabilities: { supportsNativeMessages: () => true },
        toUpstreamId: (id: string) => id,
        nativeMessages: native,
      }],
    ]);

    const { writeAiUsageRow } = await import('./usage-log.js');
    vi.mocked(writeAiUsageRow).mockClear();

    const result = await routeMessages(
      {
        adapters, redis: {} as any,
        platformPool: {} as any, runtimePool: {} as any,
        markupPct: 0, appId: 'app-1', userId: 'user-1', region: 'us-east-1',
      } as any,
      { model: 'anthropic/claude-opus-4.8', max_tokens: 200, messages: [{ role: 'user', content: 'think' }], stream: true },
      { anthropicVersion: '2023-06-01' },
    );

    // Drain the stream to trigger settlement
    expect(result.stream).toBeDefined();
    const reader = result.stream!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // estimatePromptTokens is mocked to return 10; since thinkingText is non-empty,
    // reasoningTokens should be set to 10 in the usage row.
    expect(writeAiUsageRow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ promptTokens: 12, completionTokens: 20, reasoningTokens: 10 }),
    );
  });
});
