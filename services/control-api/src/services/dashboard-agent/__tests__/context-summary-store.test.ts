import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { getContextSummary, upsertContextSummary } from '../context-summary-store.js';

const row = {
  conversation_id: 'conv-1', summary: 'S', through_message_id: 'm9',
  through_created_at: new Date('2026-11-04T00:00:00Z'), source_characters: 100,
  summary_characters: 1, model_used: 'm', updated_at: new Date('2026-11-04T00:00:01Z'),
};

describe('context summary store', () => {
  it('reads and maps a summary row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const pool = { query } as unknown as pg.Pool;
    const got = await getContextSummary(pool, 'conv-1');
    expect(got?.throughMessageId).toBe('m9');
    expect(query.mock.calls[0][1]).toEqual(['conv-1']);
  });

  it('upserts on conversation_id', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as pg.Pool;
    await upsertContextSummary(pool, {
      conversationId: 'conv-1', summary: 'S', throughMessageId: 'm9',
      throughCreatedAt: new Date('2026-11-04T00:00:00Z'),
      sourceCharacters: 100, summaryCharacters: 1, modelUsed: 'm',
    });
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (conversation_id)');
    expect(query.mock.calls[0][1]).toEqual(['conv-1', 'S', 'm9', new Date('2026-11-04T00:00:00Z'), 100, 1, 'm']);
  });
});
