import type pg from 'pg';
import type { RouterName } from './normalize.js';

export interface AiUsageRow {
  appId: string | null;
  userId: string | null;
  model: string;             // canonical id
  router: RouterName;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  chargedCreditsUsd: number;
  markupPct: number;
  fallbackChain: string[];   // router_name:reason entries from upstream fallbacks
  leaseId: string | null;
  keyType: 'platform' | 'byok';
  chargedToUser: boolean;
}

/**
 * Writes one row to ai_usage_logs (runtime-plane).
 * Caller passes the runtime pool — typically resolved via getRuntimeDbForApp.
 * Fire-and-forget posture preserved by the caller (catch + log).
 *
 * Legacy `provider` and `cost_usd` columns populated for one release; dropped in 067.
 */
export async function writeAiUsageRow(runtimePool: pg.Pool, row: AiUsageRow): Promise<void> {
  await runtimePool.query(
    `INSERT INTO ai_usage_logs (
       app_id, model, provider, prompt_tokens, completion_tokens, total_tokens,
       cost_usd, key_type, charged_to_user, request_metadata,
       router, provider_cost_usd, charged_credits_usd, markup_pct, fallback_chain, lease_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      row.appId,
      row.model,
      row.router,              // provider column = router name (legacy)
      row.promptTokens,
      row.completionTokens,
      row.totalTokens,
      row.chargedCreditsUsd,   // cost_usd = charged_credits_usd for back-compat
      row.keyType,
      row.chargedToUser,
      JSON.stringify({ user_id: row.userId }),
      row.router,
      row.providerCostUsd,
      row.chargedCreditsUsd,
      row.markupPct,
      row.fallbackChain,
      row.leaseId,
    ]
  );
}
