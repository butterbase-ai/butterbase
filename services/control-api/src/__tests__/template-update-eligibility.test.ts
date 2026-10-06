import { describe, it, expect } from 'vitest';
import { decideEligibility } from '../services/template-update-eligibility.js';
import type { Divergence, DriftResult } from '../services/app-lineage.js';

const drift = (over: Partial<DriftResult> = {}): DriftResult => ({
  is_fork: true, severed: false, source_app_id: 'app_src', behind_by: 2, releases: [], ...over,
});
const div = (over: Partial<Divergence> = {}): Divergence => ({
  repo: false, frontend: false, schema: false, rls: false,
  functions: false, config: false, has_backend_base: true, ...over,
});

describe('decideEligibility', () => {
  it('allows an unmodified fork that is behind', () => {
    expect(decideEligibility(drift(), div())).toEqual({ eligible: true, reason: 'ok' });
  });

  it('refuses a fork with modified repo', () => {
    expect(decideEligibility(drift(), div({ repo: true })))
      .toEqual({ eligible: false, reason: 'modified' });
  });

  it('refuses a fork with modified functions', () => {
    expect(decideEligibility(drift(), div({ functions: true })))
      .toEqual({ eligible: false, reason: 'modified' });
  });

  // null is UNKNOWN, not false. Asserted separately from the `true` case so a
  // falsiness bug cannot pass both.
  it('refuses when repo divergence is unknown', () => {
    expect(decideEligibility(drift(), div({ repo: null })))
      .toEqual({ eligible: false, reason: 'unknown' });
  });

  it('refuses when function divergence is unknown', () => {
    expect(decideEligibility(drift(), div({ functions: null })))
      .toEqual({ eligible: false, reason: 'unknown' });
  });

  // Schema divergence does NOT disqualify — data is preserved by the additive gate.
  it('allows despite schema divergence', () => {
    expect(decideEligibility(drift(), div({ schema: true })))
      .toEqual({ eligible: true, reason: 'ok' });
  });

  it('refuses a severed fork', () => {
    expect(decideEligibility(drift({ severed: true }), div()))
      .toEqual({ eligible: false, reason: 'severed' });
  });

  it('refuses a fork already current', () => {
    expect(decideEligibility(drift({ behind_by: 0 }), div()))
      .toEqual({ eligible: false, reason: 'current' });
  });

  it('refuses a non-fork', () => {
    expect(decideEligibility(drift({ is_fork: false }), null))
      .toEqual({ eligible: false, reason: 'not_a_fork' });
  });

  it('refuses when divergence could not be computed', () => {
    expect(decideEligibility(drift(), null))
      .toEqual({ eligible: false, reason: 'unknown' });
  });
});
