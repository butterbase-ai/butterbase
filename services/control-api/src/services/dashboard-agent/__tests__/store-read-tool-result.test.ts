import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { getToolResultMessage, getToolMessageIds } from '../store.js';

describe('getToolResultMessage', () => {
  it('scopes the lookup to the conversation and role=tool', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'm1', tool_result: { a: 1 } }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = { query } as unknown as pg.Pool;

    await expect(getToolResultMessage(pool, 'conv-1', 'm1'))
      .resolves.toEqual({ id: 'm1', toolResult: { a: 1 } });

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('conversation_id = $2');
    expect(sql).toContain("role = 'tool'");
    expect(params).toEqual(['m1', 'conv-1']);

    await expect(getToolResultMessage(pool, 'conv-1', 'missing')).resolves.toBeNull();
  });
});

describe('getToolMessageIds', () => {
  it('maps tool_call_id to row id in one conversation-scoped query', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tool_call_id: 'c1', id: 'm1' }] });
    const pool = { query } as unknown as pg.Pool;

    const ids = await getToolMessageIds(pool, 'conv-1', ['c1', 'c2']);

    expect(ids.get('c1')).toBe('m1');
    expect(query.mock.calls[0][1]).toEqual(['conv-1', ['c1', 'c2']]);
    expect(query.mock.calls[0][0]).toContain('tool_call_id = ANY($2');
  });

  it('returns an empty map without querying for an empty input', async () => {
    const query = vi.fn();
    const pool = { query } as unknown as pg.Pool;
    expect((await getToolMessageIds(pool, 'conv-1', [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
