import { describe, it, expect } from 'vitest';
import { rankRoutersForModel, estimateWorstCaseUsd, rankRoutersPresenceMode, type CatalogEntry, type CatalogRouter } from './select.js';

describe('rankRoutersForModel', () => {
  function entry(routers: Array<{ name: string; pp: number; cp: number }>): CatalogEntry {
    return {
      canonicalId: 'anthropic/claude-3-5-sonnet',
      displayName: 'Claude 3.5 Sonnet',
      updatedAt: new Date().toISOString(),
      routers: routers.map(r => ({
        name: r.name as any,
        upstreamId: 'x',
        promptPricePerMtok: r.pp,
        completionPricePerMtok: r.cp,
        contextLength: 200000,
      })),
    };
  }

  it('ranks by prompt*1 + completion*3, ascending', () => {
    const e = entry([
      { name: 'openrouter', pp: 3, cp: 15 },   // score 48
      { name: 'provider-primary', pp: 2.5, cp: 12 }, // score 38.5
      { name: 'provider-secondary', pp: 2, cp: 14 },    // score 44
    ]);
    const order = rankRoutersForModel(e, new Set(['openrouter','provider-primary','provider-secondary']));
    expect(order.map(r => r.name)).toEqual(['provider-primary', 'provider-secondary', 'openrouter']);
  });

  it('skips disabled routers', () => {
    const e = entry([
      { name: 'openrouter', pp: 3, cp: 15 },
      { name: 'provider-primary', pp: 2.5, cp: 12 },
    ]);
    const order = rankRoutersForModel(e, new Set(['openrouter']));
    expect(order.map(r => r.name)).toEqual(['openrouter']);
  });

  it('breaks ties by router name alphabetical', () => {
    const e = entry([
      { name: 'openrouter', pp: 1, cp: 1 },
      { name: 'provider-primary', pp: 1, cp: 1 },
    ]);
    const order = rankRoutersForModel(e, new Set(['openrouter','provider-primary']));
    expect(order.map(r => r.name)).toEqual(['openrouter', 'provider-primary']);
  });

  it('returns [] when no routers are enabled', () => {
    const e = entry([{ name: 'openrouter', pp: 1, cp: 1 }]);
    expect(rankRoutersForModel(e, new Set())).toEqual([]);
  });
});

describe('estimateWorstCaseUsd', () => {
  it('combines prompt × prompt_price + max × completion_price (per Mtok)', () => {
    // 1000 prompt tokens at $3/Mtok = 0.003; 4096 completion at $15/Mtok = 0.06144
    const cost = estimateWorstCaseUsd({ promptPricePerMtok: 3, completionPricePerMtok: 15 }, 1000, 4096);
    expect(cost).toBeCloseTo(0.003 + 0.06144, 5);
  });

  it('returns 0 for zero tokens', () => {
    expect(estimateWorstCaseUsd({ promptPricePerMtok: 3, completionPricePerMtok: 15 }, 0, 0)).toBe(0);
  });
});

describe('rankRoutersPresenceMode', () => {
  const mk = (name: 'openrouter' | 'provider-primary' | 'provider-secondary'): CatalogRouter => ({
    name: name as any,
    upstreamId: `${name}-id`,
    promptPricePerMtok: 1,
    completionPricePerMtok: 1,
    contextLength: 8192,
  });

  const entry = (routers: CatalogRouter[]): CatalogEntry => ({
    canonicalId: 'anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    updatedAt: '2026-05-18T00:00:00Z',
    routers,
  });

  const allEnabled = new Set(['openrouter', 'provider-primary', 'provider-secondary']);

  it('ER+IR+OR: random ER-first when random()<0.5, OR last', () => {
    const r = rankRoutersPresenceMode(
      entry([mk('openrouter'), mk('provider-primary'), mk('provider-secondary')]),
      allEnabled,
      () => 0.3,
    );
    expect(r.map(x => x.name)).toEqual(['provider-primary', 'provider-secondary', 'openrouter']);
  });

  it('ER+IR+OR: random IR-first when random()>=0.5', () => {
    const r = rankRoutersPresenceMode(
      entry([mk('openrouter'), mk('provider-primary'), mk('provider-secondary')]),
      allEnabled,
      () => 0.7,
    );
    expect(r.map(x => x.name)).toEqual(['provider-secondary', 'provider-primary', 'openrouter']);
  });

  it('ER+OR only: ER then OR', () => {
    const r = rankRoutersPresenceMode(
      entry([mk('openrouter'), mk('provider-primary')]),
      allEnabled,
      () => 0,
    );
    expect(r.map(x => x.name)).toEqual(['provider-primary', 'openrouter']);
  });

  it('IR+OR only: IR then OR', () => {
    const r = rankRoutersPresenceMode(
      entry([mk('openrouter'), mk('provider-secondary')]),
      allEnabled,
      () => 0,
    );
    expect(r.map(x => x.name)).toEqual(['provider-secondary', 'openrouter']);
  });

  it('ER+IR only: random tiebreak, no OR', () => {
    const r1 = rankRoutersPresenceMode(
      entry([mk('provider-primary'), mk('provider-secondary')]),
      allEnabled,
      () => 0.1,
    );
    expect(r1.map(x => x.name)).toEqual(['provider-primary', 'provider-secondary']);
    const r2 = rankRoutersPresenceMode(
      entry([mk('provider-primary'), mk('provider-secondary')]),
      allEnabled,
      () => 0.9,
    );
    expect(r2.map(x => x.name)).toEqual(['provider-secondary', 'provider-primary']);
  });

  it('ER only', () => {
    const r = rankRoutersPresenceMode(entry([mk('provider-primary')]), allEnabled, () => 0);
    expect(r.map(x => x.name)).toEqual(['provider-primary']);
  });

  it('IR only', () => {
    const r = rankRoutersPresenceMode(entry([mk('provider-secondary')]), allEnabled, () => 0);
    expect(r.map(x => x.name)).toEqual(['provider-secondary']);
  });

  it('OR only', () => {
    const r = rankRoutersPresenceMode(entry([mk('openrouter')]), allEnabled, () => 0);
    expect(r.map(x => x.name)).toEqual(['openrouter']);
  });

  it('ER disabled in enabled-set is filtered out before tiebreak', () => {
    const r = rankRoutersPresenceMode(
      entry([mk('openrouter'), mk('provider-primary'), mk('provider-secondary')]),
      new Set(['openrouter', 'provider-secondary']),
      () => 0,
    );
    expect(r.map(x => x.name)).toEqual(['provider-secondary', 'openrouter']);
  });

  it('empty enabled set returns []', () => {
    const r = rankRoutersPresenceMode(
      entry([mk('openrouter')]),
      new Set<string>(),
      () => 0,
    );
    expect(r).toEqual([]);
  });
});
