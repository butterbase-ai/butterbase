import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { Message } from '../store.js';
import * as summaryStore from '../context-summary-store.js';
import {
  compactReplay, replayChars, clearOldToolResults, messagesAfterWatermark, buildCompactionPrompt,
  gatewayChars, clearGatewayToolResults,
} from '../context-compaction.js';

vi.mock('../context-summary-store.js', () => ({
  getContextSummary: vi.fn(async () => null),
  upsertContextSummary: vi.fn(async () => {}),
}));

const pool = {} as pg.Pool;
const msg = (over: Partial<Message>): Message => ({
  id: 'm', conversationId: 'conv-1', role: 'user', content: '', toolCallId: null,
  toolName: null, toolArgs: null, toolResult: null, modelUsed: null,
  pendingApprovalId: null, rating: null, ratingReason: null, createdAt: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('compactReplay', () => {
  it('does nothing under budget', async () => {
    const chat = vi.fn();
    const messages = [msg({ id: 'm1', content: 'hi' })];
    const out = await compactReplay({ pool, conversationId: 'conv-1', messages, gateway: { chat } });
    expect(out.trigger).toBe('under_budget');
    expect(out.messages).toBe(messages);
    expect(chat).not.toHaveBeenCalled();
    expect(summaryStore.getContextSummary).not.toHaveBeenCalled();
  });

  it('clears old tool results before calling the gateway', async () => {
    const chat = vi.fn();
    const messages = Array.from({ length: 30 }, (_, i) =>
      msg({ id: `m${i}`, role: 'tool', toolCallId: `c${i}`, toolResult: { body: 'x'.repeat(10_000) } }));
    const out = await compactReplay({ pool, conversationId: 'conv-1', messages, gateway: { chat }, budgetChars: 290_000 });
    expect(out.trigger).toBe('cleared');
    expect(chat).not.toHaveBeenCalled();
    expect(JSON.stringify(out.messages[0].toolResult)).toContain('cleared');
    expect(JSON.stringify(out.messages[29].toolResult)).not.toContain('cleared');
  });

  it('summarizes the prefix and keeps the current user message', async () => {
    const chat = vi.fn(async () => 'SUMMARY');
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(20_000) }));
    messages[39] = msg({ id: 'm39', content: 'current question' });

    const out = await compactReplay({
      pool, conversationId: 'conv-1', messages, gateway: { chat },
      budgetChars: 100_000, keepMessages: 5, tailChars: 100_000, promptChars: 150_000,
    });

    expect(out.trigger).toBe('summarized');
    expect(out.summary).toBe('SUMMARY');
    expect(out.messages.some((m) => m.content === 'current question')).toBe(true);
    expect(summaryStore.upsertContextSummary).toHaveBeenCalled();
  });

  it('falls back to the tail when the gateway fails', async () => {
    const chat = vi.fn(async () => { throw new Error('timeout'); });
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, content: 'x'.repeat(20_000) }));
    const out = await compactReplay({ pool, conversationId: 'conv-1', messages, gateway: { chat }, budgetChars: 100_000 });
    expect(out.trigger).toBe('summary_failed');
    expect(out.summary).toBeNull();
    expect(summaryStore.upsertContextSummary).not.toHaveBeenCalled();
    expect(out.messages.length).toBeLessThan(messages.length);
  });

  it('treats an empty summary as a failure and persists nothing', async () => {
    const chat = vi.fn(async () => '   ');
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, content: 'x'.repeat(20_000) }));
    const out = await compactReplay({ pool, conversationId: 'conv-1', messages, gateway: { chat }, budgetChars: 100_000 });
    expect(out.trigger).toBe('summary_failed');
    expect(summaryStore.upsertContextSummary).not.toHaveBeenCalled();
  });

  it('truncates a summary longer than 12,000 characters', async () => {
    const chat = vi.fn(async () => 'x'.repeat(20_000));
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, content: 'x'.repeat(20_000) }));
    const out = await compactReplay({ pool, conversationId: 'conv-1', messages, gateway: { chat }, budgetChars: 100_000 });
    expect(out.trigger).toBe('summarized');
    expect(out.summary).toHaveLength(12_000);
  });

  it('falls back when the summary table is missing', async () => {
    (summaryStore.getContextSummary as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('relation "dashboard_agent_context_summaries" does not exist'));
    const chat = vi.fn(async () => 'SUMMARY');
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `m${i}`, content: 'x'.repeat(20_000) }));
    const out = await compactReplay({ pool, conversationId: 'conv-1', messages, gateway: { chat }, budgetChars: 100_000 });
    expect(out.trigger).toBe('summary_missing_table');
    expect(out.summary).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it('never starts the tail with an orphan tool result', async () => {
    const chat = vi.fn(async () => 'SUMMARY');
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(msg({ id: `a${i}`, role: 'assistant', content: 'x'.repeat(10_000), toolCallId: `c${i}`, toolName: 't', toolArgs: {} }));
      messages.push(msg({ id: `t${i}`, role: 'tool', toolCallId: `c${i}`, toolResult: { body: 'x'.repeat(10_000) } }));
    }
    const out = await compactReplay({
      pool, conversationId: 'conv-1', messages, gateway: { chat },
      budgetChars: 50_000, keepMessages: 4, tailChars: 50_000, promptChars: 150_000,
    });
    const firstTool = out.messages.find((m) => m.role === 'tool');
    if (firstTool) {
      expect(out.messages.some((m) => m.role === 'assistant' && m.toolCallId === firstTool.toolCallId)).toBe(true);
    }
  });
});

describe('helpers', () => {
  it('filters messages after the watermark by id', () => {
    const messages = ['m1', 'm2', 'm3'].map((id) => msg({ id }));
    const out = messagesAfterWatermark(messages, {
      conversationId: 'conv-1', summary: 'S', throughMessageId: 'm2',
      throughCreatedAt: new Date(), sourceCharacters: 1, summaryCharacters: 1,
      modelUsed: null, updatedAt: new Date(),
    });
    expect(out.map((m) => m.id)).toEqual(['m3']);
  });

  it('falls back to createdAt when the watermark row is gone', () => {
    const base = new Date('2026-11-04T00:00:00Z').getTime();
    const messages = ['m1', 'm2', 'm3'].map((id, i) =>
      msg({ id, createdAt: new Date(base + i * 1000) }));
    const out = messagesAfterWatermark(messages, {
      conversationId: 'conv-1', summary: 'S', throughMessageId: 'deleted',
      throughCreatedAt: new Date(base + 500), sourceCharacters: 1, summaryCharacters: 1,
      modelUsed: null, updatedAt: new Date(),
    });
    expect(out.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('includes all nine summary sections', () => {
    const prompt = buildCompactionPrompt([msg({ id: 'm1', content: 'hello' })], 'PREVIOUS');
    for (const heading of ['Primary request', 'Key technical concepts', 'Files and data', 'Errors and fixes',
      'Decisions made', 'All user messages', 'Pending tasks', 'Current work', 'Next step']) {
      expect(prompt).toContain(heading);
    }
    expect(prompt).toContain('PREVIOUS');
  });

  it('replayChars sums replayCost', () => {
    expect(replayChars([msg({ id: 'm1', content: 'abcd' })]))
      .toBeGreaterThanOrEqual(4);
  });
});

describe('mid-turn helpers', () => {
  it('clears all but the last four tool results and keeps pairing', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: 'tool' as const, tool_call_id: `c${i}`,
      content: JSON.stringify({ body: 'x'.repeat(1_000) }),
    }));
    const ids = new Map(messages.map((m, i) => [m.tool_call_id, `row-${i}`]));

    const out = clearGatewayToolResults(messages, ids, 4);

    expect(out.cleared).toBe(6);
    expect(out.messages.slice(0, 6).every((m) => m.content!.includes('cleared'))).toBe(true);
    expect(out.messages[9].content).not.toContain('cleared');
    expect(out.messages.map((m) => m.role)).toEqual(messages.map((m) => m.role));
    expect(out.messages[0].tool_call_id).toBe('c0');
  });

  it('does not clear a result with no known row id', () => {
    const messages = [
      { role: 'tool' as const, tool_call_id: 'c0', content: JSON.stringify({ body: 'x'.repeat(1_000) }) },
      { role: 'tool' as const, tool_call_id: 'c1', content: JSON.stringify({ body: 'x'.repeat(1_000) }) },
    ];
    const out = clearGatewayToolResults(messages, new Map([['c1', 'row-1']]), 0);
    expect(out.messages[0].content).not.toContain('cleared');
    expect(out.messages[1].content).toContain('cleared');
  });

  it('estimates input characters including fixed overhead', () => {
    expect(gatewayChars([{ role: 'user', content: 'abcd' }], 100)).toBeGreaterThanOrEqual(104);
  });

  it('forces summarization when force is true', async () => {
    const chat = vi.fn(async () => 'SUMMARY');
    const messages = Array.from({ length: 5 }, (_, i) => msg({ id: `m${i}`, content: 'x'.repeat(100) }));
    const out = await compactReplay({
      pool, conversationId: 'conv-1', messages, gateway: { chat },
      force: true, keepMessages: 1, tailChars: 1_000,
    });
    expect(out.trigger).toBe('summarized');
    expect(out.summary).toBe('SUMMARY');
  });
});
