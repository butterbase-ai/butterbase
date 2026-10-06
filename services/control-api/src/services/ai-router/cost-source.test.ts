import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classifyCostSource } from './cost-source.js';

const priced = { promptPricePerMtok: 0.15, completionPricePerMtok: 0.47 };
const inherited = { ...priced, priceInheritedFrom: 'openrouter' };
const unpriced = { promptPricePerMtok: 0, completionPricePerMtok: 0 };

describe('classifyCostSource', () => {
  it('upstream when the provider reported a cost', () => {
    expect(classifyCostSource(0.000051, priced)).toBe('upstream');
  });

  it('upstream even when the reported cost is legitimately 0', () => {
    // A free model really can cost $0. That must not be confused with the
    // failure case below, which is why we branch on null, not falsiness.
    expect(classifyCostSource(0, priced)).toBe('upstream');
  });

  it('catalog when estimated against the route own published rates', () => {
    expect(classifyCostSource(null, priced)).toBe('catalog');
    expect(classifyCostSource(undefined, priced)).toBe('catalog');
  });

  it('catalog_inherited when the rates were borrowed from a sibling', () => {
    expect(classifyCostSource(null, inherited)).toBe('catalog_inherited');
  });

  it('catalog_unpriced when the route carries no price — the $0 bug', () => {
    expect(classifyCostSource(null, unpriced)).toBe('catalog_unpriced');
  });

  it('catalog_unpriced when there is no route at all', () => {
    expect(classifyCostSource(null, undefined)).toBe('catalog_unpriced');
  });

  it('counts a route priced on only one side as priced', () => {
    expect(classifyCostSource(null, { promptPricePerMtok: 0, completionPricePerMtok: 0.47 })).toBe('catalog');
  });
});

describe('cost_source stays internal', () => {
  // It is billing provenance, not customer data: a customer must never be able
  // to see which of their charges we inferred.
  const files = [
    'src/services/ai-usage-logger.ts',
    'src/services/billing-service.ts',
    'src/routes/ai-config.ts',
    'src/routes/gateway.ts',
  ];

  it('is not projected by any customer-facing usage reader', () => {
    for (const f of files) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
      expect(src, `${f} must not select cost_source`).not.toMatch(/cost_source/);
    }
  });

  it('no reader uses SELECT * on ai_usage_logs, which would leak it implicitly', () => {
    for (const f of files) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
      expect(src, `${f} must not SELECT * from ai_usage_logs`)
        .not.toMatch(/select\s+\*[\s\S]{0,200}?from\s+ai_usage_logs/i);
    }
  });
});
