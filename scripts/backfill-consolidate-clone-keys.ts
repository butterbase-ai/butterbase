#!/usr/bin/env tsx
/**
 * Backfill: consolidate per-function `BUTTERBASE_API_KEY` / `BB_SUBSTRATE_KEY`
 * values to a single shared key per app.
 *
 * Background: prior to the "one shared key per clone" change, the clone job
 * minted a distinct `bb_sk_*` for every function on the cloned app. Functions
 * that called sibling functions and compared `req.headers.authorization` to
 * their own `ctx.env.BUTTERBASE_API_KEY` then failed with 401 because the
 * caller's bearer (its own minted key) never equalled the callee's env key.
 *
 * This script consolidates: for every app whose functions disagree on the
 * value of `BUTTERBASE_API_KEY` (and `BB_SUBSTRATE_KEY`), it picks one of the
 * existing values as canonical and rewrites every function's env to use it.
 *
 * Canonical selection: deterministic — the alphabetically first key among the
 * distinct values. Picking any one of the already-minted, already-app-scoped
 * keys is safe; the platform's auth layer accepts any of them. We don't mint
 * new keys (would orphan more rows) and we don't revoke the displaced ones
 * (would risk breaking any caller we missed) — orphan revocation is a
 * follow-up ops task.
 *
 * Usage:
 *   tsx scripts/backfill-consolidate-clone-keys.ts          # dry-run (default)
 *   tsx scripts/backfill-consolidate-clone-keys.ts --fix    # apply
 *   tsx scripts/backfill-consolidate-clone-keys.ts --app app_xyz   # one app
 */
import pg from 'pg';
import { encrypt, decrypt } from '../services/control-api/src/services/crypto.js';

const FIX = process.argv.includes('--fix');
const APP_ARG_IDX = process.argv.indexOf('--app');
const APP_FILTER = APP_ARG_IDX >= 0 ? process.argv[APP_ARG_IDX + 1] : null;

const KEYS_TO_CONSOLIDATE = ['BUTTERBASE_API_KEY', 'BB_SUBSTRATE_KEY'];

interface FnEnvRow {
  id: string;
  name: string;
  encrypted_env_vars: string | null;
}

interface AppPlan {
  appId: string;
  canonicalValue: string;
  affected: { fnId: string; fnName: string; oldValue: string | null; keysToWrite: string[] }[];
  displacedValues: Set<string>;
}

function pickCanonical(distinctValues: Set<string>): string {
  // Deterministic: alphabetically first. Any of the existing values would
  // work — they're all already-minted, already-app-scoped keys.
  return [...distinctValues].sort()[0];
}

function planForApp(appId: string, fns: FnEnvRow[], encKey: string): AppPlan | null {
  // Decrypt each function's env once. Track per-function values for each
  // consolidation key.
  const perFn: { row: FnEnvRow; env: Record<string, string> | null }[] = [];
  for (const row of fns) {
    if (!row.encrypted_env_vars) {
      perFn.push({ row, env: null });
      continue;
    }
    try {
      const env = JSON.parse(decrypt(row.encrypted_env_vars, encKey)) as Record<string, string>;
      perFn.push({ row, env });
    } catch (err) {
      console.warn(`[${appId}] could not decrypt env for fn=${row.name}: ${(err as Error).message}`);
      perFn.push({ row, env: null });
    }
  }

  // Collect distinct values across the keys we want to consolidate.
  const distinct = new Set<string>();
  for (const { env } of perFn) {
    if (!env) continue;
    for (const k of KEYS_TO_CONSOLIDATE) {
      if (typeof env[k] === 'string') distinct.add(env[k]);
    }
  }

  // Skip apps that are already in good shape: 0 or 1 distinct value across
  // all functions/keys means nothing to do.
  if (distinct.size <= 1) return null;

  const canonical = pickCanonical(distinct);
  const affected: AppPlan['affected'] = [];
  const displaced = new Set<string>();

  for (const { row, env } of perFn) {
    if (!env) continue;
    const keysToWrite: string[] = [];
    for (const k of KEYS_TO_CONSOLIDATE) {
      const current = env[k];
      if (typeof current !== 'string') continue;
      if (current !== canonical) {
        keysToWrite.push(k);
        displaced.add(current);
      }
    }
    if (keysToWrite.length > 0) {
      affected.push({
        fnId: row.id,
        fnName: row.name,
        oldValue: env[keysToWrite[0]] ?? null,
        keysToWrite,
      });
    }
  }

  if (affected.length === 0) return null;

  return { appId, canonicalValue: canonical, affected, displacedValues: displaced };
}

async function applyPlan(pool: pg.Pool, encKey: string, plan: AppPlan): Promise<void> {
  // Re-read + decrypt + merge + encrypt per row so we don't trample any
  // unrelated env vars that have been edited since we planned.
  for (const change of plan.affected) {
    const res = await pool.query<{ encrypted_env_vars: string | null }>(
      `SELECT encrypted_env_vars FROM app_functions WHERE id = $1`,
      [change.fnId],
    );
    const blob = res.rows[0]?.encrypted_env_vars;
    if (!blob) {
      console.warn(`  [${plan.appId}/${change.fnName}] env vanished between plan and apply; skipping`);
      continue;
    }
    const env = JSON.parse(decrypt(blob, encKey)) as Record<string, string>;
    for (const k of change.keysToWrite) {
      env[k] = plan.canonicalValue;
    }
    const enc = encrypt(JSON.stringify(env), encKey);
    await pool.query(
      `UPDATE app_functions SET encrypted_env_vars = $1, updated_at = now() WHERE id = $2`,
      [enc, change.fnId],
    );
  }
}

async function processRegion(region: string, runtimeUrl: string, encKey: string): Promise<{ plansFound: number; plansApplied: number }> {
  const pool = new pg.Pool({ connectionString: runtimeUrl });
  let plansFound = 0;
  let plansApplied = 0;
  try {
    // Find candidate apps: any app that has 2+ functions with encrypted_env_vars.
    // We can't filter on "disagrees on api key" in SQL because envs are
    // encrypted — but the candidate set is small (cloned apps), so a per-app
    // decrypt is cheap.
    const filterClause = APP_FILTER ? 'AND app_id = $1' : '';
    const params = APP_FILTER ? [APP_FILTER] : [];
    const candidates = await pool.query<{ app_id: string }>(
      `SELECT app_id
         FROM app_functions
        WHERE deleted_at IS NULL AND encrypted_env_vars IS NOT NULL ${filterClause}
        GROUP BY app_id
       HAVING COUNT(*) >= 2`,
      params,
    );

    console.log(`[${region}] ${candidates.rows.length} candidate apps`);

    for (const { app_id } of candidates.rows) {
      const fns = await pool.query<FnEnvRow>(
        `SELECT id, name, encrypted_env_vars
           FROM app_functions
          WHERE app_id = $1 AND deleted_at IS NULL`,
        [app_id],
      );
      const plan = planForApp(app_id, fns.rows, encKey);
      if (!plan) continue;
      plansFound++;

      const canonPrefix = plan.canonicalValue.slice(0, 12);
      const displacedPrefixes = [...plan.displacedValues].map(v => v.slice(0, 12)).sort();
      console.log(`  [${app_id}] needs consolidation`);
      console.log(`    canonical:  ${canonPrefix}…`);
      console.log(`    displaced:  ${displacedPrefixes.join(', ')}`);
      console.log(`    affected fns (${plan.affected.length}):`);
      for (const a of plan.affected) {
        console.log(`      - ${a.fnName}  keys=[${a.keysToWrite.join(',')}]`);
      }

      if (FIX) {
        await applyPlan(pool, encKey, plan);
        plansApplied++;
        console.log(`    ✓ applied`);
      }
    }
  } finally {
    await pool.end();
  }
  return { plansFound, plansApplied };
}

async function main(): Promise<void> {
  const encKey = process.env.AUTH_ENCRYPTION_KEY;
  if (!encKey) throw new Error('AUTH_ENCRYPTION_KEY is required');

  const regions = (process.env.BUTTERBASE_REGIONS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (regions.length === 0) throw new Error('BUTTERBASE_REGIONS is empty');

  console.log(`mode: ${FIX ? 'APPLY' : 'dry-run'} ${APP_FILTER ? `(app=${APP_FILTER})` : ''}`);
  let totalFound = 0;
  let totalApplied = 0;

  for (const region of regions) {
    const urlVar = `NEON_RUNTIME_PROJECT_ID_${region.toUpperCase().replace(/-/g, '_')}`;
    const url = process.env[urlVar];
    if (!url) {
      console.warn(`[${region}] no ${urlVar}; skipping`);
      continue;
    }
    const { plansFound, plansApplied } = await processRegion(region, url, encKey);
    totalFound += plansFound;
    totalApplied += plansApplied;
  }

  console.log(`\nsummary: ${totalFound} apps needed consolidation, ${totalApplied} applied`);
  if (!FIX && totalFound > 0) {
    console.log('(run with --fix to apply)');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
