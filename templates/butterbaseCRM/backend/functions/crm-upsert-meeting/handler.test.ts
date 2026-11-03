import { describe, expect, it, vi } from 'vitest';
import { attrsEqual, handler } from './handler';

describe('meeting attrs comparison', () => {
  it('ignores updated_at and key order', () => {
    expect(attrsEqual(
      { title: 'A', starts_at: 'x' },
      { starts_at: 'x', title: 'A', updated_at: 'y' },
    )).toBe(true);
  });

  it('detects a real change', () => {
    expect(attrsEqual({ title: 'A' }, { title: 'B' })).toBe(false);
  });

  it('compares nested values', () => {
    expect(attrsEqual({ custom_fields: { a: 1 } }, { custom_fields: { a: 1 } })).toBe(true);
    expect(attrsEqual({ custom_fields: { a: 1 } }, { custom_fields: { a: 2 } })).toBe(false);
  });
});

const meeting = (externalId: string, extra: Record<string, unknown> = {}) => new Request('http://x', {
  method: 'POST',
  body: JSON.stringify({
    workspace_id: 'ws',
    source: 'calendar',
    attrs: {
      external_event_id: externalId,
      title: 'Weekly sync',
      starts_at: '2026-11-03T09:00:00.000Z',
      ...extra,
    },
  }),
});

describe('meeting upsert writes', () => {
  it('does not rewrite an unchanged meeting found by lookup', async () => {
    const prior = {
      workspace_id: 'ws', external_event_id: 'evt-1', title: 'Weekly sync',
      starts_at: '2026-11-03T09:00:00.000Z', attendee_entity_ids: ['p1'],
      notetaker_bot_id: 'bot-1', ai_summary: 'Summary',
    };
    const propose = vi.fn();
    const ctx = { substrate: {
      findEntities: vi.fn(async () => [{ id: 'ent-1', display_name: 'Weekly sync', attrs: prior }]),
      propose,
    } };
    const res = await handler(meeting('evt-1'), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'ent-1', unchanged: true });
    expect(propose).not.toHaveBeenCalled();
  });

  it('restores attributes after the canonical-key probe updates an existing entity', async () => {
    const prior = {
      workspace_id: 'ws', external_event_id: 'evt-2', title: 'Weekly sync',
      starts_at: '2026-11-03T09:00:00.000Z',
      attendee_entity_ids: ['p1'], notetaker_bot_id: 'bot-1',
    };
    const propose = vi.fn()
      .mockResolvedValueOnce({ result: {
        entity_id: 'ent-2', was_insert: false,
        before_attrs: prior, before_display_name: 'Weekly sync',
      } })
      .mockResolvedValueOnce({ result: { entity_id: 'ent-2' } });
    const ctx = { substrate: { findEntities: vi.fn(async () => []), propose } };
    await handler(meeting('evt-2', {
      recurrence_summary: 'Recurring meeting · 30 occurrences in this window',
      occurrence_count_in_window: 30,
    }), ctx);
    expect(propose.mock.calls.map((call) => call[0])).toEqual(['upsert_entity', 'patch_entity']);
    expect(propose.mock.calls[1][1].attrs_patch).toMatchObject({
      attendee_entity_ids: ['p1'], notetaker_bot_id: 'bot-1',
      recurrence_summary: 'Recurring meeting · 30 occurrences in this window',
      occurrence_count_in_window: 30,
    });
  });
});
