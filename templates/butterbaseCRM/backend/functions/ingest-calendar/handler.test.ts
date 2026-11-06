import { describe, expect, it } from 'vitest';
import {
  buildFreshIndex, collapseRecurrence, groupBySeries, recurrenceSummary, seriesIdFor,
} from './handler';

const now = new Date('2026-11-03T12:00:00Z');
const instance = (id: string, series: string, start: string) => ({
  id,
  recurringEventId: series,
  start: { dateTime: start },
  end: { dateTime: start },
});
const thirtyDaily = Array.from({ length: 30 }, (_, i) =>
  instance(`i${i}`, 'series-1', `2026-11-${String(i + 1).padStart(2, '0')}T09:00:00Z`));

describe('recurring calendar series', () => {
  it('collapses thirty daily instances into one representative', () => {
    const kept = collapseRecurrence(thirtyDaily, now);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe('i3');
  });

  it('keeps non-recurring events untouched', () => {
    const one = { id: 'one', start: { dateTime: '2026-11-04T09:00:00Z' } };
    expect(collapseRecurrence([one], now)).toEqual([one]);
  });

  it('uses the series id, not the instance id', () => {
    expect(seriesIdFor(instance('i1', 'series-1', '2026-11-04T09:00:00Z'))).toBe('series-1');
  });

  it('keeps an in-progress occurrence as the representative', () => {
    const during = new Date('2026-11-03T09:05:00Z');
    const events = [
      { id: 'today', recurringEventId: 's', start: { dateTime: '2026-11-03T09:00:00Z' }, end: { dateTime: '2026-11-03T09:30:00Z' } },
      { id: 'tomorrow', recurringEventId: 's', start: { dateTime: '2026-11-04T09:00:00Z' }, end: { dateTime: '2026-11-04T09:30:00Z' } },
    ];
    expect(collapseRecurrence(events, during)[0].id).toBe('today');
  });

  it('ignores a cancelled occurrence when choosing', () => {
    const events = [
      { id: 'cancelled', recurringEventId: 's', status: 'cancelled', start: { dateTime: '2026-11-03T09:00:00Z' }, end: { dateTime: '2026-11-03T09:30:00Z' } },
      { id: 'tomorrow', recurringEventId: 's', start: { dateTime: '2026-11-04T09:00:00Z' }, end: { dateTime: '2026-11-04T09:30:00Z' } },
    ];
    expect(collapseRecurrence(events, new Date('2026-11-03T08:00:00Z'))[0].id).toBe('tomorrow');
  });

  it('indexes a collapsed series once, under its series id', () => {
    const index = buildFreshIndex(collapseRecurrence(thirtyDaily, now));
    expect([...index.keys()]).toEqual(['series-1']);
    expect(index.get('series-1').startsAt).toBe('2026-11-04T09:00:00.000Z');
  });

  it('summarises the window count for one series', () => {
    const groups = groupBySeries(thirtyDaily);
    expect(recurrenceSummary(groups.get('series-1')!)).toBe(
      'Recurring meeting · 30 occurrences in this window',
    );
  });
});
