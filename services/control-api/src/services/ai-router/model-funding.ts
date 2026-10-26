/**
 * Read-only model-funding inspection for cloud access policies.
 *
 * Answers "could this organization fund this model right now" WITHOUT
 * leasing, reserving, settling, debiting, calling a provider, allocating a
 * sandbox, or writing a billing event. The gateway's own admission at the
 * moment of the call remains authoritative; this precheck only lets a
 * scheduler/loop stop before starting work that has no funding.
 *
 * Funding order:
 *  1. Provider-funded coverage. A registered coupon pays only while its named
 *     router is enabled and actually ranks for the model. If the router is
 *     unavailable the coupon cannot authorize an unfunded fallback, so the
 *     decision falls through to credits.
 *  2. Credits. Allowed when the combined balance is at or above the effective
 *     floor — the same admission rule `grantLease` uses in reserve-small mode
 *     (`balance >= COALESCE(organizations.credit_floor_usd,
 *     plans.credit_floor_usd, 0)`).
 *
 * Missing or unreadable catalog/database state denies with
 * `service_unavailable`; it never fails open.
 *
 * Provider coverage is process-local registry state: a process that evaluates
 * funding must register the same `PromoCoverage` the gateway uses (the cloud
 * process bootstrap owns that registration). With no coverage registered,
 * this returns the credits decision and reads no catalog.
 */
import type pg from 'pg';
import { readOrganizationCreditState } from '../lease-service.js';
import { getRedisClient } from '../redis.js';
import { readCatalogEntry, readEnabledRouters } from './catalog.js';
import { promoFundedRouter } from './promo-coverage-registry.js';
import { rankRoutersForModel } from './select.js';

export interface ModelFundingInput {
  organizationId: string;
  /**
   * Audit identity for the call. Funding itself is organization-scoped, the
   * same way `grantLease` bills the organization but records the acting user.
   */
  userId: string;
  model: string;
}

export type ModelFundingSource = 'credits' | 'provider' | 'none';

export interface ModelFundingResult {
  allowed: boolean;
  source: ModelFundingSource;
  reason: string | null;
}

const CREDITS_REQUIRED = 'credits_required';
const SERVICE_UNAVAILABLE = 'service_unavailable';

export async function inspectModelFunding(
  controlPool: pg.Pool,
  input: ModelFundingInput,
): Promise<ModelFundingResult> {
  try {
    // Reading the row also proves the organization exists. A missing row is
    // not fundable (and the access policy denies the plan earlier).
    const creditState = await readOrganizationCreditState(controlPool, input.organizationId);
    if (!creditState) {
      return { allowed: false, source: 'none', reason: CREDITS_REQUIRED };
    }

    const fundedRouter = input.model ? await promoFundedRouter(input.model) : null;
    if (fundedRouter) {
      const redis = getRedisClient();
      const [entry, routers] = await Promise.all([
        readCatalogEntry(redis, input.model),
        readEnabledRouters(redis),
      ]);
      if (entry) {
        const enabled = new Set(routers.filter(router => router.enabled).map(router => router.name));
        const ranked = rankRoutersForModel(entry, enabled);
        if (ranked.some(router => router.name === fundedRouter)) {
          return { allowed: true, source: 'provider', reason: null };
        }
      }
      // The coupon's router is disabled, unlisted, or does not serve this
      // model. Deliberately continue to the credit check: allowing here would
      // hand out an unfunded fallback at zero credits.
    }

    if (creditState.balanceUsd >= creditState.floorUsd) {
      return { allowed: true, source: 'credits', reason: null };
    }
    return { allowed: false, source: 'none', reason: CREDITS_REQUIRED };
  } catch {
    // Any catalog/Redis/database failure denies new work safely rather than
    // assuming the caller can pay.
    return { allowed: false, source: 'none', reason: SERVICE_UNAVAILABLE };
  }
}
