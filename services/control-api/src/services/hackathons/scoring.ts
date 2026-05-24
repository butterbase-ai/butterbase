import type pg from 'pg';
import type { FieldSchema } from './field-schema.js';
import { getUrlFieldKey } from './field-schema.js';
import { getRuntimeDbForApp } from '../region-resolver.js';

interface Logger {
  error(obj: unknown, msg?: string): void;
}

interface SubmissionInput {
  id: string;
  hackathon_id: string;
  participant_id: string;
  user_id: string;
  data: Record<string, unknown>;
  app_id: string | null;
  /** When set, URL criterion reads `data[key]` for the field with `is_url: true`, else `demo_url`. */
  field_schema: FieldSchema | null;
}

/**
 * Feature definitions for criterion 2 scoring.
 * Binary features: presence of any row = full weight.
 * Range features: min(count, cap) / cap * weight.
 */
const FEATURES = [
  { key: 'database',     table: 'app_db_connections',      type: 'binary' as const },
  { key: 'functions',    table: 'app_functions',           type: 'range'  as const, cap: 5,  where: 'AND deleted_at IS NULL' },
  { key: 'auth_users',   table: 'app_users',               type: 'range'  as const, cap: 5 },
  { key: 'storage',      table: 'storage_objects',          type: 'range'  as const, cap: 10 },
  { key: 'frontend',     table: 'app_deployments',          type: 'binary' as const },
  { key: 'oauth',        table: 'app_oauth_configs',        type: 'binary' as const },
  { key: 'custom_domain',table: 'app_custom_domains',       type: 'binary' as const },
  { key: 'realtime',     table: 'app_realtime_config',      type: 'binary' as const },
  { key: 'integrations', table: 'app_integration_configs',  type: 'binary' as const },
  { key: 'ai_chat',      table: 'ai_usage_logs',            type: 'range'  as const, cap: 10 },
  { key: 'commerce',     table: 'app_products',             type: 'binary' as const },
  { key: 'rag',          table: 'rag_ingestion_queue',      type: 'binary' as const },
] as const;

const FEATURE_WEIGHT = 50 / FEATURES.length; // ~4.17 per feature

/**
 * Score a single submission asynchronously. Never throws — safe for fire-and-forget.
 */
export async function scoreSubmission(
  controlDb: pg.Pool,
  submission: SubmissionInput,
  logger: Logger,
): Promise<void> {
  try {
    // --- Criterion 1: designated URL field (or demo_url) ends in .butterbase.dev (50 pts) ---
    const urlKey =
      submission.field_schema != null
        ? getUrlFieldKey(submission.field_schema) ?? 'demo_url'
        : 'demo_url';
    const demoUrl = submission.data[urlKey];
    let criterionDemoUrl = 0;

    if (typeof demoUrl === 'string' && demoUrl.length > 0) {
      try {
        const hostname = new URL(demoUrl).hostname;
        if (hostname === 'butterbase.dev' || hostname.endsWith('.butterbase.dev')) {
          criterionDemoUrl = 50;
        }
      } catch {
        // Invalid URL — score stays 0
      }
    }

    // --- Criterion 2: feature usage (50 pts) ---
    let criterionFeatures = 0;
    const featureBreakdown: Record<string, { count: number; score: number }> = {};

    if (submission.app_id) {
      // Resolve the app's home region — feature tables live on the regional runtime DB
      // (post controlplane-apps refactor). Soft-fail to features=0 if unresolvable so
      // a single ghost app_id can't take down a whole rescore batch.
      let runtimeDb: pg.Pool | null = null;
      try {
        runtimeDb = await getRuntimeDbForApp(controlDb, submission.app_id);
      } catch (err) {
        logger.error(
          { err, submissionId: submission.id, appId: submission.app_id },
          '[scoring] Could not resolve runtime DB for app; features will be 0',
        );
      }

      if (runtimeDb) {
        // Build a single CTE query to count all features in one round-trip
        const ctes = FEATURES.map((f, i) => {
          const extra = 'where' in f && f.where ? ` ${f.where}` : '';
          return `f${i} AS (SELECT COUNT(*) AS cnt FROM ${f.table} WHERE app_id = $1${extra})`;
        });

        const selects = FEATURES.map((_, i) => `(SELECT cnt FROM f${i}) AS f${i}`);
        const sql = `WITH ${ctes.join(', ')} SELECT ${selects.join(', ')}`;
        const { rows } = await runtimeDb.query(sql, [submission.app_id]);
        const row = rows[0];

        for (let i = 0; i < FEATURES.length; i++) {
          const f = FEATURES[i];
          const count = Number(row[`f${i}`]) || 0;
          let score = 0;

          if (f.type === 'binary') {
            score = count > 0 ? FEATURE_WEIGHT : 0;
          } else {
            score = (Math.min(count, f.cap) / f.cap) * FEATURE_WEIGHT;
          }

          featureBreakdown[f.key] = { count, score: Math.round(score * 100) / 100 };
          criterionFeatures += score;
        }

        criterionFeatures = Math.round(criterionFeatures * 100) / 100;
      }
    }

    const totalScore = Math.round((criterionDemoUrl + criterionFeatures) * 100) / 100;

    // --- Upsert score ---
    await controlDb.query(
      `INSERT INTO hackathon_scores (
          submission_id, hackathon_id, participant_id, user_id,
          criterion_demo_url, criterion_features, total_score,
          feature_breakdown, scored_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (submission_id) DO UPDATE SET
          criterion_demo_url  = EXCLUDED.criterion_demo_url,
          criterion_features  = EXCLUDED.criterion_features,
          total_score         = EXCLUDED.total_score,
          feature_breakdown   = EXCLUDED.feature_breakdown,
          scored_at           = now()`,
      [
        submission.id,
        submission.hackathon_id,
        submission.participant_id,
        submission.user_id,
        criterionDemoUrl,
        criterionFeatures,
        totalScore,
        JSON.stringify(featureBreakdown),
      ],
    );
  } catch (err) {
    logger.error({ err, submissionId: submission.id }, '[scoring] Failed to score submission');
  }
}
