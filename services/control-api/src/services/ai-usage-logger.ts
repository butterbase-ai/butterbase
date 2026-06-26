// services/control-api/src/services/ai-usage-logger.ts
import { Pool } from 'pg';
import { incrementUsage } from './usage-metering.js';
import { getRuntimeDbForApp } from './region-resolver.js';

export interface AiUsageLog {
  appId: string;
  userId: string | null;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  keyType: 'byok' | 'platform';
  chargedToUser: boolean;
  costUsd?: number;
}

/**
 * Log AI usage to database and increment usage meter
 * Fire-and-forget - does not block the response
 */
export async function logAiUsage(db: Pool, log: AiUsageLog): Promise<void> {
  // ai_usage_logs lives in the app's home region's runtime DB.
  const runtimePool = await getRuntimeDbForApp(db, log.appId);

  try {
    // Use actual cost from OpenRouter if provided, otherwise fall back to local estimate
    const costUsd = log.costUsd ?? calculateCost(log.model, log.promptTokens, log.completionTokens);

    // Insert into ai_usage_logs table (runtime-tier)
    await runtimePool.query(
      `INSERT INTO ai_usage_logs (app_id, user_id, model, provider, prompt_tokens, completion_tokens, total_tokens, cost_usd, key_type, charged_to_user, request_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        log.appId,
        log.userId,
        log.model,
        log.provider,
        log.promptTokens,
        log.completionTokens,
        log.totalTokens,
        costUsd,
        log.keyType,
        log.chargedToUser,
        JSON.stringify({ user_id: log.userId }),
      ]
    );

    // Meter against the caller (log.userId), not the app owner. Pre-028 this
    // resolved owner_id via apps and silently skipped null-app-id rows; now
    // app-less / non-owned-app calls also land in usage_meters.
    if (log.chargedToUser && log.userId) {
      await incrementUsage(log.userId, 'ai_tokens', log.totalTokens, log.appId ?? undefined);
    }
  } catch (error) {
    // Don't throw - logging should never block the response
    console.error('Failed to log AI usage:', error);
  }
}

/**
 * Calculate cost based on model and token usage
 * Simplified pricing - in production, fetch from OpenRouter API
 */
function calculateCost(model: string, promptTokens: number, completionTokens: number): number {
  // Simplified pricing (per 1M tokens)
  const pricing: Record<string, { prompt: number; completion: number }> = {
    'anthropic/claude-3.5-sonnet': { prompt: 3.0, completion: 15.0 },
    'anthropic/claude-3-opus': { prompt: 15.0, completion: 75.0 },
    'anthropic/claude-3-haiku': { prompt: 0.25, completion: 1.25 },
    'openai/gpt-4-turbo': { prompt: 10.0, completion: 30.0 },
    'openai/gpt-4': { prompt: 30.0, completion: 60.0 },
    'openai/gpt-3.5-turbo': { prompt: 0.5, completion: 1.5 },
    'meta-llama/llama-3.1-70b-instruct': { prompt: 0.35, completion: 0.4 },
    'meta-llama/llama-3.1-8b-instruct': { prompt: 0.06, completion: 0.06 },
    // Embedding models
    'openai/text-embedding-3-small': { prompt: 0.02, completion: 0 },
    'openai/text-embedding-3-large': { prompt: 0.13, completion: 0 },
    'openai/text-embedding-ada-002': { prompt: 0.10, completion: 0 },
  };

  // Default pricing if model not found
  const modelPricing = pricing[model] || { prompt: 1.0, completion: 2.0 };

  const promptCost = (promptTokens / 1_000_000) * modelPricing.prompt;
  const completionCost = (completionTokens / 1_000_000) * modelPricing.completion;

  return promptCost + completionCost;
}

/**
 * Get AI usage summary for an app
 */
export async function getAiUsageSummary(
  db: Pool,
  appId: string,
  startDate?: string,
  endDate?: string
): Promise<{
  totalTokens: number;
  totalCost: number;
  byModel: Record<string, { tokens: number; cost: number; requests: number }>;
  meetings: Array<{ dimension: string; seconds: number; usd: number }>;
}> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const end = endDate || new Date().toISOString().split('T')[0];

  // ai_usage_logs is runtime-tier.
  const result = await runtimePool.query(
    `SELECT model,
            COUNT(*)::text          AS requests,
            SUM(total_tokens)::text AS tokens,
            SUM(cost_usd)::text     AS cost
       FROM ai_usage_logs
      WHERE app_id = $1 AND DATE(created_at) >= $2 AND DATE(created_at) <= $3
      GROUP BY model`,
    [appId, start, end]
  );

  const byModel: Record<string, { tokens: number; cost: number; requests: number }> = {};
  let totalTokens = 0;
  let totalCost = 0;

  for (const row of result.rows) {
    const tokens = parseInt(row.tokens, 10);
    const cost = parseFloat(row.cost);
    const requests = parseInt(row.requests, 10);

    byModel[row.model] = { tokens, cost, requests };
    totalTokens += tokens;
    totalCost += cost;
  }

  // actor_usage_logs (meetings) is also runtime-tier.
  const meetingsResult = await runtimePool.query<{ dimension: string; total_seconds: string; total_usd: string }>(
    `SELECT dimension,
            SUM(seconds)::TEXT AS total_seconds,
            SUM(usd_charged)::TEXT AS total_usd
       FROM actor_usage_logs
      WHERE app_id = $1
        AND DATE(created_at) >= $2 AND DATE(created_at) <= $3
      GROUP BY dimension`,
    [appId, start, end],
  );
  const meetings = meetingsResult.rows.map(r => ({
    dimension: r.dimension,
    seconds: Number(r.total_seconds ?? 0),
    usd: Number(r.total_usd ?? 0),
  }));

  return { totalTokens, totalCost, byModel, meetings };
}
