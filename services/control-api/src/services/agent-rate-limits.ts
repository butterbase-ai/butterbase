import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

export interface LimitDef {
  key: string;
  limit: number | null | undefined;
  windowSeconds: number;
}

export interface LimitResult {
  allowed: boolean;
  current: number;
  max: number | null;
  resetAt: number; // unix seconds
}

/**
 * Atomically increments a Redis counter and returns whether the call is within the limit.
 * Increment happens regardless; if the post-increment count exceeds the limit, returns allowed=false.
 */
export async function checkAndIncrementCounter(
  redis: Redis,
  def: LimitDef,
): Promise<LimitResult> {
  if (def.limit == null) {
    return { allowed: true, current: 0, max: null, resetAt: 0 };
  }
  const pipe = redis.multi();
  pipe.incr(def.key);
  pipe.expire(def.key, def.windowSeconds, 'NX');
  pipe.ttl(def.key);
  const res = await pipe.exec();
  if (!res) throw new Error('redis pipeline failed');
  const current = Number(res[0][1]);
  const ttl = Number(res[2][1]);
  const resetAt = Math.floor(Date.now() / 1000) + Math.max(ttl, 0);
  return {
    allowed: current <= def.limit,
    current: Math.min(current, def.limit),
    max: def.limit,
    resetAt,
  };
}

export async function resetCounterKey(redis: Redis, key: string): Promise<void> {
  await redis.del(key);
}

/**
 * Sum of cost (USD) for an agent today (UTC).
 * agent_usage stores cents in cost_usd_cents and has no agent_id; join through agent_runs.
 */
export async function getDailyCostUsd(
  db: Pool,
  agentId: string,
): Promise<number> {
  const r = await db.query(
    `SELECT COALESCE(SUM(u.cost_usd_cents), 0)::numeric / 100.0 AS total
       FROM agent_usage u
       JOIN agent_runs r ON r.id = u.run_id
      WHERE r.agent_id = $1
        AND u.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    [agentId],
  );
  return Number(r.rows[0]?.total ?? 0);
}

export async function getActiveRunCount(
  db: Pool,
  agentId: string,
): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM agent_runs
      WHERE agent_id = $1
        AND status IN ('queued','running','paused','cancelling','waiting_for_human')`,
    [agentId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export interface RateLimitDecision {
  allowed: boolean;
  reason?: 'max_runs_per_user_per_hour'
         | 'max_runs_per_ip_per_hour'
         | 'max_runs_per_app_per_hour'
         | 'daily_budget_usd'
         | 'max_concurrent_runs';
  current?: number;
  max?: number | null;
  resetAt?: number;
}

/**
 * Bundle all per-agent limit checks. Owner runs should bypass this entirely.
 */
export async function applyAllLimits(
  redis: Redis,
  db: Pool,
  agent: {
    id: string;
    app_id: string;
    max_runs_per_user_per_hour: number | null;
    max_runs_per_ip_per_hour: number | null;
    max_runs_per_app_per_hour: number | null;
    daily_budget_usd: string | null;
    max_concurrent_runs: number | null;
  },
  caller: { userId: string | null; ip: string | null },
): Promise<RateLimitDecision> {
  const hour = 60 * 60;
  if (caller.userId && agent.max_runs_per_user_per_hour != null) {
    const r = await checkAndIncrementCounter(redis, {
      key: `agent_rl:${agent.id}:user:${caller.userId}`,
      limit: agent.max_runs_per_user_per_hour,
      windowSeconds: hour,
    });
    if (!r.allowed) return { allowed: false, reason: 'max_runs_per_user_per_hour', current: r.current, max: r.max, resetAt: r.resetAt };
  }
  if (caller.ip && agent.max_runs_per_ip_per_hour != null) {
    const r = await checkAndIncrementCounter(redis, {
      key: `agent_rl:${agent.id}:ip:${caller.ip}`,
      limit: agent.max_runs_per_ip_per_hour,
      windowSeconds: hour,
    });
    if (!r.allowed) return { allowed: false, reason: 'max_runs_per_ip_per_hour', current: r.current, max: r.max, resetAt: r.resetAt };
  }
  if (agent.max_runs_per_app_per_hour != null) {
    const r = await checkAndIncrementCounter(redis, {
      key: `agent_rl:${agent.id}:app`,
      limit: agent.max_runs_per_app_per_hour,
      windowSeconds: hour,
    });
    if (!r.allowed) return { allowed: false, reason: 'max_runs_per_app_per_hour', current: r.current, max: r.max, resetAt: r.resetAt };
  }
  if (agent.daily_budget_usd != null) {
    const spent = await getDailyCostUsd(db, agent.id);
    const cap = Number(agent.daily_budget_usd);
    if (spent >= cap) {
      return {
        allowed: false, reason: 'daily_budget_usd',
        current: spent, max: cap,
        resetAt: Math.floor(Date.now() / 1000) + 86400,
      };
    }
  }
  if (agent.max_concurrent_runs != null) {
    const active = await getActiveRunCount(db, agent.id);
    if (active >= agent.max_concurrent_runs) {
      return {
        allowed: false, reason: 'max_concurrent_runs',
        current: active, max: agent.max_concurrent_runs,
      };
    }
  }
  return { allowed: true };
}
