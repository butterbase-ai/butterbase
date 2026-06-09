/**
 * Schema replay for clone jobs.
 *
 * Reads the source app's schema via introspection, diffs it against an empty
 * current schema, and applies the resulting DDL to the destination app's DB.
 * Idempotent: applyMigration is a diff-apply, so if it ran partially on a
 * prior attempt the next call will only apply what's still missing.
 */

import type pg from 'pg';
import { introspectSchema } from './schema-introspector.js';
import { diffSchema } from './schema-differ.js';
import { applyMigration } from './schema-applier.js';
import type { SchemaDSL } from './schema-validator.js';
import { introspectRls } from './rls-introspector.js';
import AdmZip from 'adm-zip';
import * as R2 from './r2.js';
import * as DeploymentService from './deployment.service.js';
import { encrypt } from './crypto.js';
import { listSourceEnvVarKeys, mintApiKeyForClone } from './clone-env-vars.js';

export interface ReplayFunctionsEnvVarOpts {
  /** Per-function env var values the user supplied at clone-create time. */
  pendingEnvVarValues?: Record<string, Record<string, string>>;
  /** Per-function keys to auto-mint a scoped bb_sk_* into. */
  autoMintRequests?: { fn_name: string; key: string }[];
  /** Control DB pool — required when autoMintRequests is non-empty. */
  controlPool?: pg.Pool;
  /** Dest app owner id — required for auto-mint (key is minted under this user). */
  destAppOwnerId?: string;
}

/**
 * File extensions inside the published bundle that we treat as text and rewrite.
 * App IDs are baked into JS at build time (VITE_APP_ID), and occasionally appear
 * in HTML (<meta>), JSON config, source maps, etc. Everything else (images,
 * fonts, wasm, .br/.gz precompressed assets) is copied through untouched.
 */
const REWRITEABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.tsx',
  '.html', '.htm',
  '.css',
  '.json', '.map',
  '.txt', '.xml', '.svg',
  '.webmanifest',
]);

/**
 * Rewrite occurrences of `sourceAppId` to `destAppId` inside text files of a
 * published frontend zip. App IDs use the `app_` prefix + 14 random alphanumeric
 * characters (~73 bits of entropy via APP_ID_ALPHABET), so accidental collisions
 * with unrelated substrings in minified code are negligible.
 *
 * Rebuilds the zip from scratch via addFile rather than mutating the input via
 * updateFile + toBuffer. Source bundles produced by streaming zippers (e.g.
 * archiver) carry data descriptors per entry; AdmZip 0.5.x's toBuffer doesn't
 * round-trip those correctly, leaving an EOCD-valid zip whose entries throw
 * "ADM-ZIP: No descriptor present" the next time anything calls getData().
 * Re-adding each entry's already-decoded bytes into a fresh AdmZip avoids that
 * code path and yields a standard zip with sizes/CRCs in the local headers.
 *
 * Returns the rewritten buffer plus a count of files touched, for logging.
 */
function rewriteAppIdInArtifact(
  buffer: Buffer,
  sourceAppId: string,
  destAppId: string,
): { buffer: Buffer; filesRewritten: number; totalReplacements: number } {
  const inZip = new AdmZip(buffer);
  const outZip = new AdmZip();
  let filesRewritten = 0;
  let totalReplacements = 0;

  for (const entry of inZip.getEntries()) {
    if (entry.isDirectory) continue;
    const data = entry.getData();
    const name = entry.entryName.toLowerCase();
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot) : '';

    let outData = data;
    if (REWRITEABLE_EXTENSIONS.has(ext) && data.includes(sourceAppId)) {
      const text = data.toString('utf8');
      const occurrences = text.split(sourceAppId).length - 1;
      if (occurrences > 0) {
        outData = Buffer.from(text.split(sourceAppId).join(destAppId), 'utf8');
        filesRewritten += 1;
        totalReplacements += occurrences;
      }
    }

    outZip.addFile(entry.entryName, outData);
  }

  return { buffer: outZip.toBuffer(), filesRewritten, totalReplacements };
}

export interface ReplayLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * Replay the source app's schema onto the dest app's database.
 *
 * @param sourceAppPool - Connected pool for the source app's per-app DB.
 * @param destAppPool   - Connected pool for the dest app's per-app DB.
 * @param destAppId     - Dest app ID (used in the migration log name only).
 * @param logger        - Logger compatible with pino's info/warn interface.
 */
export async function replaySchema(
  sourceAppPool: pg.Pool,
  destAppPool: pg.Pool,
  destAppId: string,
  logger: ReplayLogger,
): Promise<void> {
  // 1. Introspect the source app's current schema.
  const sourceDsl = await introspectSchema(sourceAppPool);

  const tableCount = Object.keys(sourceDsl.tables).length;
  if (tableCount === 0) {
    logger.info({ destAppId }, '[clone] source has no user tables; skipping schema replay');
    return;
  }

  // 2. Diff against the dest's CURRENT schema (not an empty schema) so that
  //    re-running replaySchema is idempotent: tables that already exist produce
  //    no diff statements and are skipped rather than erroring with
  //    "relation already exists".
  const currentDestSchema = await introspectSchema(destAppPool);
  const statements = diffSchema(currentDestSchema as unknown as SchemaDSL, sourceDsl as unknown as SchemaDSL);

  if (statements.length === 0) {
    logger.info({ destAppId }, '[clone] diff produced no statements; skipping schema replay');
    return;
  }

  // 3. Apply the statements to the dest DB.
  await applyMigration(destAppPool, statements, 'clone-replay-schema');

  logger.info(
    { destAppId, tableCount, statementCount: statements.length },
    '[clone] schema replayed',
  );
}

// ---------------------------------------------------------------------------
// replaySeedData
// ---------------------------------------------------------------------------

const SEED_BATCH_SIZE = 500;

/**
 * Copy rows from every seed-flagged table on the source DB into the matching
 * table on the dest DB.
 *
 * Seed-flagged tables are recorded in the source's `_seed_tables` registry
 * (populated by Phase 4d's schema-applier when `_seed: true` is set on a
 * table).  Apps that pre-date the bootstrap won't have `_seed_tables` at all;
 * in that case the function returns immediately with an empty result
 * (forward-compat / soft-fail).
 *
 * Per-table soft-fail: a constraint / column-mismatch error on INSERT is
 * recorded as a warning and the copy continues with the next table.
 *
 * @param sourceAppPool - Connected pool for the source app's per-app DB.
 * @param destAppPool   - Connected pool for the dest app's per-app DB.
 * @param logger        - Logger compatible with pino's info/warn interface.
 * @returns `{ tables, rows, warnings }` — tables successfully copied, total
 *          rows inserted, and any per-table warning strings.
 */
export async function replaySeedData(
  sourceAppPool: pg.Pool,
  destAppPool: pg.Pool,
  logger: ReplayLogger,
): Promise<{ tables: string[]; rows: number; warnings: string[] }> {
  let flagged;
  try {
    flagged = await sourceAppPool.query<{ name: string }>(`SELECT name FROM _seed_tables`);
  } catch (err) {
    // Forward-compat: apps pre-dating the _seed_tables bootstrap don't have it.
    logger.warn({ err }, '[clone] _seed_tables missing on source; no seed copy');
    return { tables: [], rows: 0, warnings: [] };
  }
  const warnings: string[] = [];
  let totalRows = 0;
  const tablesCopied: string[] = [];
  for (const row of flagged.rows) {
    const table = row.name;
    const cols = await sourceAppPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    );
    if (cols.rows.length === 0) {
      warnings.push(`Seed table ${table} flagged but has no columns; skipping`);
      continue;
    }
    const colList = cols.rows.map(c => `"${c.column_name}"`).join(', ');
    let offset = 0;
    while (true) {
      const batch = await sourceAppPool.query(
        `SELECT ${colList} FROM "${table}" ORDER BY 1 OFFSET ${offset} LIMIT ${SEED_BATCH_SIZE}`,
      );
      if (batch.rows.length === 0) break;
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const r of batch.rows) {
        const rowPh = cols.rows.map(() => `$${i++}`);
        placeholders.push(`(${rowPh.join(', ')})`);
        for (const c of cols.rows) values.push((r as Record<string, unknown>)[c.column_name]);
      }
      const sql = `INSERT INTO "${table}" (${colList}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`;
      try {
        await destAppPool.query(sql, values);
        totalRows += batch.rows.length;
      } catch (err) {
        warnings.push(`Seed insert into ${table} failed at offset ${offset}: ${(err as Error).message}`);
        logger.warn({ table, offset, err }, '[clone] seed insert failed; continuing with next table');
        break;
      }
      offset += SEED_BATCH_SIZE;
      if (batch.rows.length < SEED_BATCH_SIZE) break;
    }
    tablesCopied.push(table);
  }
  return { tables: tablesCopied, rows: totalRows, warnings };
}

// ---------------------------------------------------------------------------
// replayRls helpers
// ---------------------------------------------------------------------------

const CMD_MAP: Record<string, string> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL',
};

/**
 * Replay RLS policies from the source app's database onto the dest app's database.
 *
 * Soft-fails per-policy: if a policy fails to apply (e.g. due to a missing
 * column or function reference), the error is recorded as a warning and the
 * clone continues. The caller is responsible for persisting the warnings.
 *
 * @param sourceAppPool - Connected pool for the source app's per-app DB.
 * @param destAppPool   - Connected pool for the dest app's per-app DB.
 * @param logger        - Logger compatible with pino's info/warn interface.
 * @returns `{ replayed, warnings }` — count of successfully replayed policies
 *          and an array of warning strings for failed ones.
 */
export async function replayRls(
  sourceAppPool: pg.Pool,
  destAppPool: pg.Pool,
  logger: ReplayLogger,
): Promise<{ replayed: number; warnings: string[] }> {
  const policies = await introspectRls(sourceAppPool);
  const warnings: string[] = [];
  let replayed = 0;

  for (const p of policies) {
    const cmd = CMD_MAP[p.command] ?? 'ALL';
    const roles =
      p.roles.length === 0 || p.roles.includes('public')
        ? 'PUBLIC'
        : p.roles.map(r => `"${r}"`).join(', ');
    const usingClause = p.using ? `USING (${p.using})` : '';
    const checkClause = p.with_check ? `WITH CHECK (${p.with_check})` : '';
    const sql = [
      `CREATE POLICY "${p.name}" ON "${p.table}"`,
      `AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}`,
      `FOR ${cmd}`,
      `TO ${roles}`,
      usingClause,
      checkClause,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    try {
      await destAppPool.query(sql);
      replayed++;
    } catch (err) {
      const msg = `RLS policy ${p.table}.${p.name} failed: ${(err as Error).message}`;
      warnings.push(msg);
      logger.warn(
        { table: p.table, policy: p.name, err },
        '[clone] RLS policy replay failed; continuing',
      );
    }
  }

  return { replayed, warnings };
}

// ---------------------------------------------------------------------------
// replayFunctions
// ---------------------------------------------------------------------------

/**
 * Copy non-deleted app_functions rows from the source app's runtime DB into
 * the dest app's runtime DB, then mirror each function's function_triggers
 * rows across.
 *
 * Behavior-defining columns on app_functions (name, code, description,
 * timeout_ms, memory_limit_mb, agent_tool, agent_tool_description,
 * agent_tool_mode, agent_tool_exposed_to) are copied verbatim.  Triggers
 * live in a child table after the function_triggers cutover; this function
 * re-inserts them under the new dest function id.  Runtime-stat columns
 * (invocation_count, error_count, etc.) are left at their defaults.
 * encrypted_env_vars is intentionally blanked (NULL) per the secrets
 * allowlist policy unless `opts` provides values.
 *
 * Soft-fails per function: an insert error is recorded as a warning and the
 * clone continues with the next function.
 *
 * NOTE: app_functions lives in the RUNTIME DB (not the per-app DB), so this
 * function accepts runtime-DB pools, not per-app pools.
 *
 * @param sourceRuntimePool   - Runtime DB pool for the source app's region.
 * @param destRuntimePool     - Runtime DB pool for the dest app's region.
 * @param sourceAppId         - Source app ID.
 * @param destAppId           - Dest app ID.
 * @param requestedByUserId   - User ID to record as deployed_by on dest rows.
 * @param logger              - Logger compatible with pino's info/warn interface.
 * @param opts                - Optional env var staging options. When omitted,
 *                              behaviour is identical to the pre-opts baseline:
 *                              encrypted_env_vars is left NULL on all dest rows.
 *                              `opts.pendingEnvVarValues` supplies user-provided
 *                              values; `opts.autoMintRequests` triggers bb_sk_*
 *                              key generation per function/key pair.
 * @returns `{ count, warnings, unfilledEnvVars }` — rows successfully inserted,
 *          warning strings, and a map of function name → source env var keys that
 *          were not covered by either provided values or auto-mint.
 */
export async function replayFunctions(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  requestedByUserId: string,
  logger: ReplayLogger,
  opts?: ReplayFunctionsEnvVarOpts,
): Promise<{ count: number; warnings: string[]; unfilledEnvVars: Record<string, string[]> }> {
  const src = await sourceRuntimePool.query<{
    id: string;
    name: string;
    code: string;
    description: string | null;
    timeout_ms: number;
    memory_limit_mb: number;
    agent_tool: boolean;
    agent_tool_description: string | null;
    agent_tool_mode: string | null;
    agent_tool_exposed_to: string | null;
  }>(
    `SELECT id, name, code, description,
            timeout_ms, memory_limit_mb,
            agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to
       FROM app_functions
      WHERE app_id = $1 AND deleted_at IS NULL`,
    [sourceAppId],
  );

  const warnings: string[] = [];
  let inserted = 0;
  const unfilledEnvVars: Record<string, string[]> = {};

  // Pre-compute "what env vars does each source function need" — we use this
  // to subtract filled (provided + auto-minted) keys and surface the rest.
  // Soft-fail: if AUTH_ENCRYPTION_KEY is missing or any source blob fails to
  // decrypt, fall back to an empty map so the rest of replay still runs.
  let sourceKeysMap: Map<string, Set<string>> = new Map();
  try {
    const sourceKeysByFn = await listSourceEnvVarKeys(sourceRuntimePool, sourceAppId, logger);
    sourceKeysMap = new Map(sourceKeysByFn.map(f => [f.fn_name, new Set(f.keys)]));
  } catch (err) {
    logger.warn({ err }, '[clone] listSourceEnvVarKeys failed; unfilledEnvVars will be empty');
  }

  for (const f of src.rows) {
    try {
      const ins = await destRuntimePool.query<{ id: string }>(
        `INSERT INTO app_functions (
           id, app_id,
           name, code, description,
           timeout_ms, memory_limit_mb,
           agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to,
           encrypted_env_vars,
           deployed_by, deployed_at
         ) VALUES (
           gen_random_uuid(), $1,
           $2, $3, $4,
           $5, $6,
           $7, $8, $9, $10,
           NULL,
           $11, now()
         )
         ON CONFLICT (app_id, name) DO NOTHING
         RETURNING id`,
        [
          destAppId,
          f.name, f.code, f.description,
          f.timeout_ms, f.memory_limit_mb,
          f.agent_tool, f.agent_tool_description, f.agent_tool_mode, f.agent_tool_exposed_to,
          requestedByUserId,
        ],
      );

      // ON CONFLICT DO NOTHING returns no rows when a row already existed —
      // leave its triggers alone in that case.
      const destFnId = ins.rows[0]?.id;
      if (destFnId) {
        // Copy function_triggers from source to dest.  Source rows reference
        // the source function id; rewrite to the dest function + dest app id.
        const trigSrc = await sourceRuntimePool.query<{
          trigger_type: string;
          trigger_config: unknown;
          enabled: boolean;
        }>(
          `SELECT trigger_type, trigger_config, enabled
             FROM function_triggers WHERE function_id = $1`,
          [f.id],
        );
        for (const t of trigSrc.rows) {
          await destRuntimePool.query(
            `INSERT INTO function_triggers (function_id, app_id, trigger_type, trigger_config, enabled)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (function_id, trigger_type) DO NOTHING`,
            [destFnId, destAppId, t.trigger_type, t.trigger_config, t.enabled],
          );
        }

        // --- new: apply env vars ---
        const provided = opts?.pendingEnvVarValues?.[f.name] ?? {};
        const merged: Record<string, string> = { ...provided };

        const autoFor = opts?.autoMintRequests?.filter(r => r.fn_name === f.name) ?? [];
        for (const r of autoFor) {
          if (!opts?.controlPool || !opts?.destAppOwnerId) {
            logger.warn(
              { fn: f.name, key: r.key },
              '[clone] auto-mint requested but controlPool or destAppOwnerId missing; skipping',
            );
            continue;
          }
          try {
            const minted = await mintApiKeyForClone(opts.controlPool, {
              ownerId: opts.destAppOwnerId,
              destAppId,
              fnName: f.name,
            });
            merged[r.key] = minted.key;
          } catch (mintErr) {
            warnings.push(`Auto-mint failed for ${f.name}/${r.key}: ${(mintErr as Error).message}`);
            logger.warn({ err: mintErr, fn: f.name, key: r.key }, '[clone] auto-mint failed; continuing');
          }
        }

        // `filled` tracks keys that actually made it into the dest function row.
        // Default empty — only populated after a successful UPDATE so a failed
        // write (missing AUTH_ENCRYPTION_KEY, DB error, failed auto-mint) leaves
        // its keys in `unfilledEnvVars` for the dashboard banner.
        let filled = new Set<string>();
        if (Object.keys(merged).length > 0) {
          const encKey = process.env.AUTH_ENCRYPTION_KEY;
          if (!encKey) {
            warnings.push(`Cannot write env vars for ${f.name}: AUTH_ENCRYPTION_KEY not configured`);
            logger.warn({ fn: f.name }, '[clone] AUTH_ENCRYPTION_KEY missing; skipping env var write');
          } else {
            try {
              const enc = encrypt(JSON.stringify(merged), encKey);
              await destRuntimePool.query(
                `UPDATE app_functions SET encrypted_env_vars = $1, updated_at = now() WHERE id = $2`,
                [enc, destFnId],
              );
              filled = new Set(Object.keys(merged));
            } catch (writeErr) {
              warnings.push(`Failed to write env vars for ${f.name}: ${(writeErr as Error).message}`);
              logger.warn({ err: writeErr, fn: f.name }, '[clone] env var write failed; keys will remain unfilled');
            }
          }
        }

        // --- new: track unfilled ---
        // Derive filled from what we actually wrote, NOT from `merged` or
        // `autoFor` — a failed auto-mint, missing encryption key, or DB write
        // failure must leave the key in the unfilled set.
        const srcKeys = sourceKeysMap.get(f.name);
        if (srcKeys) {
          const unfilled = [...srcKeys].filter(k => !filled.has(k));
          if (unfilled.length > 0) unfilledEnvVars[f.name] = unfilled;
        }
      }

      inserted++;
    } catch (err) {
      const msg = `Function ${f.name} replay failed: ${(err as Error).message}`;
      warnings.push(msg);
      logger.warn({ name: f.name, err }, '[clone] function replay failed; continuing');
    }
  }

  return { count: inserted, warnings, unfilledEnvVars };
}

// ---------------------------------------------------------------------------
// replayNonSecretConfig — step 6
// ---------------------------------------------------------------------------
//
// Six config subsystems live in the RUNTIME DB. Their locations and blanking
// rules are summarised here so future auditors can cross-check:
//
//   apps.storage_config      JSONB   — copy verbatim (no secrets)
//   apps.jwt_config          JSONB   — copy verbatim (signing keys live in
//                                      app_signing_keys, NOT here)
//   apps.allowed_origins     text[]  — copy verbatim (CORS whitelist)
//   apps.ai_config           JSONB   — copy all fields EXCEPT byokKey which
//                                      is BLANKED (encrypted BYOK API key)
//   app_realtime_config      TABLE   — copy verbatim (per-table RT flags)
//                                      columns: id, app_id, table_name,
//                                      events, enabled, created_at, updated_at
//                                      unique: (app_id, table_name)
//   app_oauth_configs        TABLE   — copy provider/urls/scopes/metadata;
//                                      BLANK client_id + client_secret_encrypted
//                                      columns: id, app_id, provider,
//                                      client_id, client_secret_encrypted,
//                                      scopes, authorization_url, token_url,
//                                      userinfo_url, enabled, created_at,
//                                      redirect_uris, provider_metadata
//                                      unique: (app_id, provider)

async function replayStorageConfig(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  warnings: string[],
  logger: ReplayLogger,
): Promise<void> {
  try {
    const src = await sourceRuntimePool.query<{ storage_config: unknown }>(
      `SELECT storage_config FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    if (src.rows.length === 0) {
      warnings.push('storage_config: source app row not found; skipping');
      return;
    }
    await destRuntimePool.query(
      `UPDATE apps SET storage_config = $1, updated_at = now() WHERE id = $2`,
      [src.rows[0].storage_config, destAppId],
    );
    logger.info({ destAppId }, '[clone] storage_config replayed');
  } catch (err) {
    const msg = `storage_config replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] storage_config replay failed; continuing');
  }
}

async function replayJwtConfig(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  warnings: string[],
  logger: ReplayLogger,
): Promise<void> {
  try {
    const src = await sourceRuntimePool.query<{ jwt_config: unknown }>(
      `SELECT jwt_config FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    if (src.rows.length === 0) {
      warnings.push('jwt_config: source app row not found; skipping');
      return;
    }
    await destRuntimePool.query(
      `UPDATE apps SET jwt_config = $1, updated_at = now() WHERE id = $2`,
      [src.rows[0].jwt_config, destAppId],
    );
    logger.info({ destAppId }, '[clone] jwt_config replayed');
  } catch (err) {
    const msg = `jwt_config replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] jwt_config replay failed; continuing');
  }
}

async function replayAllowedOrigins(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  warnings: string[],
  logger: ReplayLogger,
): Promise<void> {
  try {
    const src = await sourceRuntimePool.query<{ allowed_origins: string[] }>(
      `SELECT allowed_origins FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    if (src.rows.length === 0) {
      warnings.push('allowed_origins: source app row not found; skipping');
      return;
    }
    await destRuntimePool.query(
      `UPDATE apps SET allowed_origins = $1, updated_at = now() WHERE id = $2`,
      [src.rows[0].allowed_origins, destAppId],
    );
    logger.info({ destAppId }, '[clone] allowed_origins replayed');
  } catch (err) {
    const msg = `allowed_origins replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] allowed_origins replay failed; continuing');
  }
}

async function replayAiConfig(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  warnings: string[],
  logger: ReplayLogger,
): Promise<void> {
  try {
    const src = await sourceRuntimePool.query<{ ai_config: Record<string, unknown> | null }>(
      `SELECT ai_config FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    if (src.rows.length === 0) {
      warnings.push('ai_config: source app row not found; skipping');
      return;
    }
    // Strip the BYOK key; all other non-secret fields (defaultModel, etc.) copy verbatim.
    const raw = src.rows[0].ai_config ?? {};
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { byokKey: _blanked, ...safeConfig } = raw;
    await destRuntimePool.query(
      `UPDATE apps SET ai_config = $1, updated_at = now() WHERE id = $2`,
      [safeConfig, destAppId],
    );
    logger.info({ destAppId, byokBlanked: 'byokKey' in raw }, '[clone] ai_config replayed');
  } catch (err) {
    const msg = `ai_config replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] ai_config replay failed; continuing');
  }
}

async function replayRealtimeConfig(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  warnings: string[],
  logger: ReplayLogger,
): Promise<void> {
  try {
    const src = await sourceRuntimePool.query<{
      table_name: string;
      events: string[];
      enabled: boolean;
    }>(
      `SELECT table_name, events, enabled FROM app_realtime_config WHERE app_id = $1`,
      [sourceAppId],
    );
    if (src.rows.length === 0) {
      logger.info({ destAppId }, '[clone] no realtime config to replay');
      return;
    }
    for (const row of src.rows) {
      try {
        await destRuntimePool.query(
          `INSERT INTO app_realtime_config (id, app_id, table_name, events, enabled)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)
           ON CONFLICT (app_id, table_name) DO UPDATE
             SET events = EXCLUDED.events, enabled = EXCLUDED.enabled, updated_at = now()`,
          [destAppId, row.table_name, row.events, row.enabled],
        );
      } catch (err) {
        const msg = `app_realtime_config row ${row.table_name} failed: ${(err as Error).message}`;
        warnings.push(msg);
        logger.warn({ table: row.table_name, err }, '[clone] realtime config row failed; continuing');
      }
    }
    logger.info({ destAppId, count: src.rows.length }, '[clone] realtime config replayed');
  } catch (err) {
    const msg = `app_realtime_config replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] realtime config replay failed; continuing');
  }
}

async function replayOauthConfigs(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  warnings: string[],
  logger: ReplayLogger,
): Promise<void> {
  try {
    const src = await sourceRuntimePool.query<{
      provider: string;
      scopes: string[] | null;
      authorization_url: string | null;
      token_url: string | null;
      userinfo_url: string | null;
      enabled: boolean;
      redirect_uris: string[];
      provider_metadata: Record<string, unknown>;
    }>(
      // client_id and client_secret_encrypted are intentionally excluded from SELECT.
      `SELECT provider, scopes, authorization_url, token_url,
              userinfo_url, enabled, redirect_uris, provider_metadata
         FROM app_oauth_configs
        WHERE app_id = $1`,
      [sourceAppId],
    );
    if (src.rows.length === 0) {
      logger.info({ destAppId }, '[clone] no oauth configs to replay');
      return;
    }
    for (const row of src.rows) {
      try {
        await destRuntimePool.query(
          `INSERT INTO app_oauth_configs (
             id, app_id, provider,
             client_id, client_secret_encrypted,
             scopes, authorization_url, token_url, userinfo_url,
             enabled, redirect_uris, provider_metadata
           ) VALUES (
             gen_random_uuid(), $1, $2,
             NULL, NULL,
             $3, $4, $5, $6,
             $7, $8, $9
           )
           ON CONFLICT (app_id, provider) DO UPDATE
             SET client_id              = NULL,
                 client_secret_encrypted = NULL,
                 scopes                 = EXCLUDED.scopes,
                 authorization_url      = EXCLUDED.authorization_url,
                 token_url              = EXCLUDED.token_url,
                 userinfo_url           = EXCLUDED.userinfo_url,
                 enabled                = EXCLUDED.enabled,
                 redirect_uris          = EXCLUDED.redirect_uris,
                 provider_metadata      = EXCLUDED.provider_metadata`,
          [
            destAppId, row.provider,
            row.scopes, row.authorization_url, row.token_url, row.userinfo_url,
            row.enabled, row.redirect_uris, row.provider_metadata,
          ],
        );
      } catch (err) {
        const msg = `app_oauth_configs row ${row.provider} failed: ${(err as Error).message}`;
        warnings.push(msg);
        logger.warn({ provider: row.provider, err }, '[clone] oauth config row failed; continuing');
      }
    }
    logger.info({ destAppId, count: src.rows.length }, '[clone] oauth configs replayed');
  } catch (err) {
    const msg = `app_oauth_configs replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] oauth configs replay failed; continuing');
  }
}

// ---------------------------------------------------------------------------
// replayAuthHookBinding — step 6 sub-task (Phase 5 A6)
// ---------------------------------------------------------------------------

/**
 * Copy the source app's `auth_hook_function` binding to the dest app, but
 * ONLY if the referenced function was successfully replicated (i.e. a
 * non-deleted row with that name exists in dest's `app_functions`).
 *
 * If the function is absent on dest the binding is left NULL and a warning is
 * appended so operators know the hook will not fire on the template clone.
 *
 * NOTE: `auth_hook_function` lives on the `apps` row in the RUNTIME DB
 * (not the per-app DB), so this function takes runtime-DB pools.
 *
 * @param sourceRuntimePool - Runtime DB pool for the source app's region.
 * @param destRuntimePool   - Runtime DB pool for the dest app's region.
 * @param sourceAppId       - Source app ID.
 * @param destAppId         - Dest app ID.
 * @param logger            - Logger compatible with pino's info/warn interface.
 * @returns `{ warnings }` — warning strings if the binding could not be applied.
 */
export async function replayAuthHookBinding(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  logger: ReplayLogger,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];

  try {
    const src = await sourceRuntimePool.query<{ auth_hook_function: string | null }>(
      `SELECT auth_hook_function FROM apps WHERE id = $1`,
      [sourceAppId],
    );
    const hookName = src.rows[0]?.auth_hook_function;

    // Nothing to copy.
    if (!hookName) return { warnings };

    // Verify the function was replicated to dest (not soft-deleted).
    const exists = await destRuntimePool.query(
      `SELECT 1 FROM app_functions WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
      [destAppId, hookName],
    );

    if ((exists.rowCount ?? 0) === 0) {
      const msg = `auth_hook_function "${hookName}" not replicated to dest; binding left NULL`;
      warnings.push(msg);
      logger.warn(
        { hookName, destAppId },
        '[clone] auth_hook_function not found on dest; binding left NULL',
      );
      return { warnings };
    }

    await destRuntimePool.query(
      `UPDATE apps SET auth_hook_function = $1, updated_at = now() WHERE id = $2`,
      [hookName, destAppId],
    );
    logger.info({ destAppId, hookName }, '[clone] auth_hook_function binding replayed');
  } catch (err) {
    const msg = `auth_hook_function replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] auth_hook_function replay failed; continuing');
  }

  return { warnings };
}

/**
 * Replay all non-secret config from the source app's runtime DB onto the dest
 * app's runtime DB (step 6 of the clone pipeline).
 *
 * Subsystems and their blanking rules:
 *   - storage_config (apps.storage_config)      — verbatim
 *   - jwt_config (apps.jwt_config)              — verbatim
 *   - allowed_origins (apps.allowed_origins)    — verbatim
 *   - ai_config (apps.ai_config)                — byokKey BLANKED; rest verbatim
 *   - app_realtime_config (table)               — verbatim
 *   - app_oauth_configs (table)                 — client_id + client_secret_encrypted BLANKED
 *
 * Each subsystem soft-fails independently: an error is pushed to `warnings`
 * and the function continues with the next subsystem.
 */
export async function replayNonSecretConfig(
  sourceRuntimePool: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  logger: ReplayLogger,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  await replayStorageConfig(sourceRuntimePool, destRuntimePool, sourceAppId, destAppId, warnings, logger);
  await replayJwtConfig(sourceRuntimePool, destRuntimePool, sourceAppId, destAppId, warnings, logger);
  await replayAllowedOrigins(sourceRuntimePool, destRuntimePool, sourceAppId, destAppId, warnings, logger);
  await replayAiConfig(sourceRuntimePool, destRuntimePool, sourceAppId, destAppId, warnings, logger);
  await replayRealtimeConfig(sourceRuntimePool, destRuntimePool, sourceAppId, destAppId, warnings, logger);
  await replayOauthConfigs(sourceRuntimePool, destRuntimePool, sourceAppId, destAppId, warnings, logger);
  return { warnings };
}

// ---------------------------------------------------------------------------
// replayFrontend — step 7
// ---------------------------------------------------------------------------

/**
 * Replay the source app's most recent published frontend onto the dest by
 * copying the persisted artifact slot from R2 and running it through the
 * standard publish pipeline against the dest's CF Pages project.
 *
 * Storage model: every successful deploy overwrites `app-artifact/{appId}.zip`
 * with the byte-for-byte published bundle (see deployArtifact). Clones copy
 * that object, rewrite occurrences of the source app id inside text files
 * (JS/HTML/JSON/etc.) to the dest id — so the cloned frontend hits the dest's
 * API and user pool, not the source's — and re-publish.
 *
 * No-op (with a clear log) when the source has no persisted artifact, e.g.
 * apps that have never deployed a frontend. The CF Pages project gets
 * provisioned lazily inside deployViaPages on first publish, so no separate
 * project-create step is needed here.
 *
 * Soft-fails: errors are recorded as warnings and the broader clone job
 * is allowed to complete (the schema/RLS/functions/etc. are already done;
 * the user can re-publish their frontend manually).
 */
export async function replayFrontend(
  controlDb: pg.Pool,
  destRuntimePool: pg.Pool,
  sourceAppId: string,
  destAppId: string,
  userId: string,
  logger: ReplayLogger,
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];

  try {
    const srcKey = R2.appArtifactKey(sourceAppId);
    const dstKey = R2.appArtifactKey(destAppId);

    const head = await R2.head(srcKey);
    if (!head.exists) {
      logger.info(
        { sourceAppId, destAppId },
        '[clone] source has no persisted frontend artifact; skipping frontend replay',
      );
      return { warnings };
    }

    await R2.copyObject(srcKey, dstKey);

    // app_deployments is runtime-tier (per-region). r2_object_key points at
    // the persistent slot, NOT a transient source/{id}.zip — runDeploymentPipeline
    // would delete the key on success, which is why we bypass it and call
    // deployArtifact directly below.
    const dep = await destRuntimePool.query<{ id: string }>(
      `INSERT INTO app_deployments (app_id, framework, status, deployed_by, r2_object_key)
       VALUES ($1, 'other', 'UPLOADING', $2, $3)
       RETURNING id`,
      [destAppId, userId, dstKey],
    );
    const deploymentId = dep.rows[0].id;

    const sourceBuffer = await R2.getObjectAsBuffer(dstKey);
    // The source bundle has `VITE_APP_ID=<sourceAppId>` baked into its JS at
    // build time. Republishing it byte-for-byte would leave the cloned frontend
    // calling /auth/<sourceAppId>/..., /v1/<sourceAppId>/..., etc. — hitting
    // the source app's user pool and data instead of the dest's. Rewrite the
    // app id inside text files before publishing.
    const { buffer: rewrittenBuffer, filesRewritten, totalReplacements } =
      rewriteAppIdInArtifact(sourceBuffer, sourceAppId, destAppId);
    if (filesRewritten === 0) {
      logger.warn(
        { sourceAppId, destAppId },
        '[clone] frontend artifact had no occurrences of source app id; cloned frontend may still target the source app',
      );
    }

    // Persist the rewritten artifact back to the dest's R2 slot so future
    // resume/redeploy paths read the corrected bundle, not the original copy.
    if (filesRewritten > 0) {
      await R2.putObject(dstKey, rewrittenBuffer, 'application/zip');
    }

    await DeploymentService.deployArtifact(controlDb, deploymentId, rewrittenBuffer);

    logger.info(
      { destAppId, deploymentId, bytes: head.contentLength, filesRewritten, totalReplacements },
      '[clone] frontend replayed',
    );
  } catch (err) {
    const msg = `frontend replay failed: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn({ err }, '[clone] frontend replay failed; continuing');
  }

  return { warnings };
}
