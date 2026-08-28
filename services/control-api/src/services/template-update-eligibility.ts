import type { Divergence, DriftResult } from './app-lineage.js';

export type EligibilityReason =
  | 'ok' | 'not_a_fork' | 'severed' | 'current' | 'modified' | 'unknown';

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
}

/**
 * Gated on repo + function divergence only. Schema divergence is irrelevant
 * here because the update applies additive-only DDL, so a diverged schema
 * carries no data risk.
 *
 * Order matters: `modified` is reported before `unknown` so a fork we KNOW is
 * modified gets the accurate reason even if another surface is unknown.
 */
export function decideEligibility(
  drift: DriftResult,
  divergence: Divergence | null,
): EligibilityResult {
  if (!drift.is_fork) return { eligible: false, reason: 'not_a_fork' };
  if (drift.severed) return { eligible: false, reason: 'severed' };
  if (drift.behind_by <= 0) return { eligible: false, reason: 'current' };
  if (divergence === null) return { eligible: false, reason: 'unknown' };

  const surfaces = [divergence.repo, divergence.functions];
  if (surfaces.some((s) => s === true)) return { eligible: false, reason: 'modified' };
  if (surfaces.some((s) => s !== false)) return { eligible: false, reason: 'unknown' };

  return { eligible: true, reason: 'ok' };
}
