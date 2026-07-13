// services/control-api/src/services/durable-objects.service.ts
//
// Service layer for Durable Objects. Owns the synchronous register/delete flows
// that bundle all of an app's DO classes into a single Worker, push it to
// Workers for Platforms, and persist the lifecycle/deploy state.
//
// Key invariants:
//   - We always read every active class for an app from the DB and bundle them
//     all together. We never deploy a partial set.
//   - The migrations diff (new_classes / deleted_classes) is computed against
//     `app_do_deploy_state.deployed_class_names` and persisted on success.
//   - Status transitions: PENDING -> BUILDING -> READY (or ERROR with message).
import crypto from 'node:crypto';
import { Pool } from 'pg';
import * as CloudflareWfp from './cloudflare-wfp.js';
import { decrypt, encrypt } from './crypto.js';
import {
  extractClassName,
  buildBundle,
  BundlerError,
  type AccessMode,
  type ClassDef,
} from './do-bundler.js';
import { validateEnvKeys } from '../lib/env-vars.js';
import { buildDoEnvBundle } from './do-env-bundle.js';
import { config } from '../config.js';

export class DurableObjectError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'DurableObjectError';
  }
}

export interface RegisterInput {
  name: string;
  code: string;
  access_mode: AccessMode;
}

// Same shape as the bundler's name regex so the two layers cannot diverge.
const NAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function doScriptName(appId: string): string {
  return `${appId}_do`;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

interface ActiveClassRow {
  id: string;
  name: string;
  class_name: string;
  code: string;
  access_mode: AccessMode;
}

async function loadActiveClasses(db: Pool, appId: string): Promise<ActiveClassRow[]> {
  const r = await db.query(
    `SELECT id, name, class_name, code, access_mode FROM app_durable_objects
     WHERE app_id = $1 AND status IN ('PENDING', 'BUILDING', 'READY')
     ORDER BY name`,
    [appId],
  );
  return r.rows;
}

interface PrevDeployState {
  classNames: string[];
  migrationTag: string | null;
}

async function loadPrevDeployState(db: Pool, appId: string): Promise<PrevDeployState> {
  const r = await db.query(
    `SELECT deployed_class_names, migration_tag FROM app_do_deploy_state WHERE app_id = $1`,
    [appId],
  );
  return {
    classNames: r.rows[0]?.deployed_class_names ?? [],
    migrationTag: r.rows[0]?.migration_tag ?? null,
  };
}

/**
 * Loads the app's persisted DO env vars and decrypts each value. Returns an
 * empty object if none exist. The same AUTH_ENCRYPTION_KEY envelope is used
 * for app_frontend_env_vars and app_do_env_vars; no per-table key separation.
 */
async function loadDoOnlyEnvVars(db: Pool, appId: string): Promise<Record<string, string>> {
  const r = await db.query<{ key: string; encrypted_value: string }>(
    `SELECT key, encrypted_value FROM app_do_env_vars WHERE app_id = $1`,
    [appId],
  );
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  const out: Record<string, string> = {};
  for (const row of r.rows) {
    out[row.key] = decrypt(row.encrypted_value, encKey);
  }
  return out;
}

async function loadAppLevelEnvVars(db: Pool, appId: string): Promise<Record<string, string>> {
  const r = await db.query<{ encrypted_env_vars: string }>(
    `SELECT encrypted_env_vars FROM app_env_vars WHERE app_id = $1`,
    [appId],
  );
  if (r.rows.length === 0) return {};
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  try {
    return JSON.parse(decrypt(r.rows[0].encrypted_env_vars, encKey)) as Record<string, string>;
  } catch {
    return {};
  }
}

interface PlatformDoEnvFields {
  BUTTERBASE_APP_ID: string;
  BUTTERBASE_API_URL: string;
  BUTTERBASE_APP_NAME: string;
  BUTTERBASE_REGION: string;
  BUTTERBASE_ANON_KEY: string;
  BUTTERBASE_SUBDOMAIN?: string;
  BUTTERBASE_FRONTEND_URL?: string;
  BUTTERBASE_STRIPE_ACCOUNT_ID?: string;
  BUTTERBASE_AI_DEFAULT_MODEL?: string;
}

async function fetchAppRowForPlatformEnv(
  controlDb: Pool,
  appId: string,
): Promise<{
  name: string; region: string; anon_key: string;
  subdomain: string | null; deployment_url: string | null;
  stripe_connect_account_id: string | null; ai_config: unknown;
}> {
  const r = await controlDb.query(
    `SELECT name, region, anon_key, subdomain, deployment_url,
            stripe_connect_account_id, ai_config
       FROM apps WHERE id = $1`,
    [appId],
  );
  if (r.rows.length === 0) throw new DurableObjectError(`App ${appId} not found`, 'APP_NOT_FOUND');
  return r.rows[0];
}

async function resolvePlatformDoEnv(controlDb: Pool, appId: string): Promise<PlatformDoEnvFields> {
  const app = await fetchAppRowForPlatformEnv(controlDb, appId);
  const fields: PlatformDoEnvFields = {
    BUTTERBASE_APP_ID: appId,
    BUTTERBASE_API_URL: config.apiBaseUrl,
    BUTTERBASE_APP_NAME: app.name,
    BUTTERBASE_REGION: app.region,
    BUTTERBASE_ANON_KEY: app.anon_key,
  };
  if (app.subdomain) fields.BUTTERBASE_SUBDOMAIN = app.subdomain;
  if (app.deployment_url) fields.BUTTERBASE_FRONTEND_URL = app.deployment_url;
  if (app.stripe_connect_account_id) fields.BUTTERBASE_STRIPE_ACCOUNT_ID = app.stripe_connect_account_id;
  const aiDefault = (app.ai_config as { defaultModel?: string } | null)?.defaultModel;
  if (typeof aiDefault === 'string') fields.BUTTERBASE_AI_DEFAULT_MODEL = aiDefault;
  return fields;
}

async function fetchInternalFnKeyForApp(controlDb: Pool, appId: string): Promise<string | null> {
  const r = await controlDb.query<{ kv_function_key: string }>(
    `SELECT kv_function_key FROM app_kv_credentials WHERE app_id = $1 LIMIT 1`,
    [appId],
  );
  return r.rows[0]?.kv_function_key ?? null;
}

async function persistDeployState(
  db: Pool,
  appId: string,
  classNames: string[],
  bundleSha: string,
  migrationTag: string,
): Promise<void> {
  await db.query(
    `INSERT INTO app_do_deploy_state (app_id, deployed_class_names, bundle_sha, migration_tag, deployed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (app_id) DO UPDATE
       SET deployed_class_names = EXCLUDED.deployed_class_names,
           bundle_sha = EXCLUDED.bundle_sha,
           migration_tag = EXCLUDED.migration_tag,
           deployed_at = EXCLUDED.deployed_at`,
    [appId, classNames, bundleSha, migrationTag],
  );
}

/**
 * Map a raw CF / network error from `deployDoWorker` into a `DurableObjectError`
 * with a code the route layer can translate to a meaningful HTTP response.
 * Without this, the error bubbles as a generic 500 and the user sees nothing
 * actionable.
 */
function wrapCfDeployError(err: unknown): DurableObjectError {
  const raw = err instanceof Error ? err.message : String(err);

  // CF migration tag precondition failed — most commonly because the local
  // deploy state lost track of the tag. Our backfill should prevent this; if
  // it still fires, surface a clear remediation.
  if (raw.includes('[10079]') || raw.includes('Actor migration tag')) {
    return new DurableObjectError(
      `Cloudflare rejected the Durable Object deploy: migration tag mismatch. ` +
        `This usually means the deploy state was reset while the CF script still exists. ` +
        `Original error: ${raw}`,
      'CF_MIGRATION_TAG_MISMATCH',
    );
  }

  // Class definition / migration shape errors from CF.
  if (raw.includes('[10021]') || raw.includes('migration')) {
    return new DurableObjectError(
      `Cloudflare rejected the Durable Object migration. Original error: ${raw}`,
      'CF_INVALID_MIGRATION',
    );
  }

  // Any other CF API failure.
  if (raw.includes('CF API error')) {
    return new DurableObjectError(
      `Cloudflare rejected the Durable Object deploy. Original error: ${raw}`,
      'CF_DEPLOY_FAILED',
    );
  }

  // Network / unknown — still wrap so we never leak a bare 500.
  return new DurableObjectError(
    `Failed to deploy Durable Object Worker to Cloudflare: ${raw}`,
    'CF_DEPLOY_FAILED',
  );
}

/**
 * Bundle the current set of classes for an app and deploy via WfP. Computes
 * the migrations diff against the prior deploy state, then UPSERTs the new
 * deploy state on success. Throws on bundler/deploy failure.
 */
async function bundleAndDeploy(
  db: Pool,
  controlDb: Pool,
  appId: string,
  preloadedActive?: ActiveClassRow[],
): Promise<void> {
  const active = preloadedActive ?? (await loadActiveClasses(db, appId));

  if (active.length === 0) {
    // The caller should have routed to deleteDoWorker instead. This is a
    // programmer error, not a user-visible one.
    throw new DurableObjectError('bundleAndDeploy called with no active classes', 'EMPTY_BUNDLE');
  }

  // ClassDef intentionally has no `className` field — buildBundle re-extracts
  // it from the source so the two layers cannot diverge. The DB column
  // `class_name` is still derived from the same source on insert, so the set
  // computed here matches the set used for the migration diff below.
  const classDefs: ClassDef[] = active.map((row) => ({
    name: row.name,
    code: row.code,
    access_mode: row.access_mode,
  }));

  let built;
  try {
    built = buildBundle(classDefs);
  } catch (err) {
    if (err instanceof BundlerError) {
      throw new DurableObjectError(err.message, err.code);
    }
    throw err;
  }

  const currentClassNames = active.map((c) => c.class_name);
  const prev = await loadPrevDeployState(db, appId);

  const new_classes = currentClassNames.filter((n) => !prev.classNames.includes(n));
  const deleted_classes = prev.classNames.filter((n) => !currentClassNames.includes(n));

  const scriptName = doScriptName(appId);

  // Backfill the migration tag from CF when the local deploy state is missing
  // it but a CF script already exists (e.g. apps deployed before we started
  // persisting the tag). Without this, the PUT below fails with [10079].
  let oldTag = prev.migrationTag;
  if (oldTag == null) {
    try {
      oldTag = await CloudflareWfp.getDoWorkerMigrationTag(scriptName);
    } catch (err) {
      throw wrapCfDeployError(err);
    }
  }

  const [platformEnv, appEnvVars, doEnvVars, internalFnKey] = await Promise.all([
    resolvePlatformDoEnv(controlDb, appId),
    loadAppLevelEnvVars(db, appId),
    loadDoOnlyEnvVars(db, appId),
    fetchInternalFnKeyForApp(controlDb, appId),
  ]);

  const { envVars, collisions } = buildDoEnvBundle({
    platformEnv: platformEnv as unknown as Record<string, string>,
    appEnvVars,
    doEnvVars,
    internalFnKey,
    doBindingNames: built.bindingNames,
  });

  if (collisions.length > 0) {
    const first = collisions[0];
    throw new DurableObjectError(
      `DO env var key '${first.key}' collides with a DO namespace binding. Rename the env var or the conflicting class.`,
      'ENV_BINDING_COLLISION',
    );
  }

  let result;
  try {
    result = await CloudflareWfp.deployDoWorker({
      scriptName,
      bundle: built.bundle,
      classNames: currentClassNames,
      bindingNames: built.bindingNames,
      migrations: { new_classes, deleted_classes },
      oldTag,
      envVars,
    });
  } catch (err) {
    throw wrapCfDeployError(err);
  }

  await persistDeployState(db, appId, currentClassNames, sha256(built.bundle), result.newTag);
}

/**
 * Register a new DO class or update an existing one. Synchronously bundles
 * and deploys; returns once the WfP script has been updated. Status is READY
 * on success, ERROR on any failure (the row is always written either way so
 * the user can see the message).
 */
export async function registerDurableObject(
  db: Pool,
  controlDb: Pool,
  appId: string,
  userId: string,
  input: RegisterInput,
): Promise<{ id: string; name: string; status: 'READY'; class_name: string }> {
  if (!NAME_REGEX.test(input.name)) {
    throw new DurableObjectError(
      `Invalid DO name: ${input.name}. Must be lowercase kebab-case (e.g. 'chat-room').`,
      'INVALID_NAME',
    );
  }

  // Parse the user's source up front so we fail fast (and with a clear error)
  // before touching the DB. class_name is NOT NULL in the schema so we need
  // the parsed value before INSERT anyway.
  let className: string;
  try {
    className = extractClassName(input.code);
  } catch (err) {
    if (err instanceof BundlerError) {
      throw new DurableObjectError(err.message, err.code);
    }
    throw err;
  }

  const codeSha = sha256(input.code);

  // Upsert directly as BUILDING — no intermediate PENDING write, so there is
  // no window where a process crash leaves a row stuck in PENDING with nothing
  // to recover it.
  const upsert = await db.query(
    `INSERT INTO app_durable_objects (app_id, name, class_name, code, code_sha, access_mode, status, deployed_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'BUILDING', $7)
     ON CONFLICT (app_id, name) DO UPDATE
       SET class_name = EXCLUDED.class_name,
           code = EXCLUDED.code,
           code_sha = EXCLUDED.code_sha,
           access_mode = EXCLUDED.access_mode,
           status = 'BUILDING',
           error_message = NULL,
           updated_at = now()
     RETURNING id`,
    [appId, input.name, className, input.code, codeSha, input.access_mode, userId],
  );
  const id = upsert.rows[0].id as string;

  try {
    await bundleAndDeploy(db, controlDb, appId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await db.query(
      `UPDATE app_durable_objects SET status = 'ERROR', error_message = $1, updated_at = now() WHERE id = $2`,
      [msg, id],
    );
    throw err;
  }

  await db.query(
    `UPDATE app_durable_objects SET status = 'READY', error_message = NULL, last_deployed_at = now(), updated_at = now() WHERE id = $1`,
    [id],
  );

  return { id, name: input.name, status: 'READY', class_name: className };
}

export interface DurableObjectListItem {
  id: string;
  name: string;
  class_name: string;
  status: string;
  access_mode: string;
  last_deployed_at: Date | null;
  error_message: string | null;
}

export async function listDurableObjects(
  db: Pool,
  appId: string,
): Promise<DurableObjectListItem[]> {
  const r = await db.query(
    `SELECT id, name, class_name, status, access_mode, last_deployed_at, error_message
     FROM app_durable_objects
     WHERE app_id = $1
     ORDER BY created_at DESC`,
    [appId],
  );
  return r.rows;
}

export interface DurableObjectDetail extends DurableObjectListItem {
  code: string;
  created_at: Date;
  updated_at: Date;
}

export async function getDurableObject(
  db: Pool,
  appId: string,
  name: string,
): Promise<DurableObjectDetail | null> {
  const r = await db.query(
    `SELECT id, name, class_name, code, access_mode, status, error_message, last_deployed_at, created_at, updated_at
     FROM app_durable_objects
     WHERE app_id = $1 AND name = $2`,
    [appId, name],
  );
  return r.rows[0] ?? null;
}

/**
 * Delete a DO class. Re-bundles the remaining classes and redeploys with a
 * `deleted_classes` migration. If this was the last class, tear down the WfP
 * script entirely via deleteDoWorker.
 */
export async function deleteDurableObject(
  db: Pool,
  controlDb: Pool,
  appId: string,
  name: string,
): Promise<void> {
  const found = await db.query(
    `SELECT id, class_name FROM app_durable_objects WHERE app_id = $1 AND name = $2`,
    [appId, name],
  );
  if (found.rows.length === 0) {
    throw new DurableObjectError('DO not found', 'NOT_FOUND');
  }

  // Delete first so loadActiveClasses returns the post-delete set.
  await db.query(
    `DELETE FROM app_durable_objects WHERE app_id = $1 AND name = $2`,
    [appId, name],
  );

  const remaining = await loadActiveClasses(db, appId);

  if (remaining.length === 0) {
    // Tear down the script entirely. We do this BEFORE writing the empty
    // deploy state so that if WfP rejects we don't leave the DB claiming an
    // empty bundle while the script still exists.
    try {
      await CloudflareWfp.deleteDoWorker(doScriptName(appId));
    } catch (err) {
      throw wrapCfDeployError(err);
    }
    await persistDeployState(db, appId, [], '', '');
    return;
  }

  // Re-bundle and redeploy with the deleted_classes migration. We pass the
  // already-loaded active set so we don't re-query (and so it matches the
  // post-DELETE snapshot above). The diff is computed against the previous
  // deploy state (which still contains the deleted class).
  await bundleAndDeploy(db, controlDb, appId, remaining);
}

export interface DurableObjectUsage {
  do_requests: number;
  do_cpu_ms: number;
}

/**
 * Read DO usage meters for an app for a given period. NOTE: per-class usage
 * is not stored in v1 — the analytics puller attributes per-script (i.e.
 * per-app), so the `name` argument is accepted for forward compatibility but
 * the returned numbers are app-wide totals. `do_storage_gb_seconds` is not
 * surfaced because the v1 puller does not write it (planned for v2); the
 * MeterType union still includes it for forward compatibility.
 */
/**
 * List the env var keys (no values) configured for an app's DOs. Values are
 * never returned by the API — once written they are write-only from the
 * caller's perspective; only the deployed DO Worker can read them.
 */
export async function listDoEnvVarKeys(db: Pool, appId: string): Promise<string[]> {
  const r = await db.query<{ key: string }>(
    `SELECT key FROM app_do_env_vars WHERE app_id = $1 ORDER BY key`,
    [appId],
  );
  return r.rows.map((row) => row.key);
}

export interface CloneReplayResult {
  cloned: string[];
  do_env_keys: string[];
}

/**
 * Clone every active DO class from `sourceAppId` (source runtime DB) to
 * `destAppId` (dest runtime DB), then bundle-and-deploy the dest's DOs to
 * its own CF Worker namespace. Called from executeClone before functions
 * replay so that functions whose env vars reference `<appId>_do` URLs can
 * be pointed at the dest namespace by the caller.
 *
 * Values of DO env vars are NOT copied — they're secrets held only in the
 * source's encryption envelope. Their KEYS are returned so the clone caller
 * can surface them alongside function env keys in the pending_env_vars flow.
 *
 * If the source has no active DOs, returns `{ cloned: [], do_env_keys: [] }`
 * without deploying anything.
 */
export async function replayDurableObjectsForClone(
  sourceDb: Pool,
  destDb: Pool,
  controlDb: Pool,
  sourceAppId: string,
  destAppId: string,
  destUserId: string,
): Promise<CloneReplayResult> {
  const src = await sourceDb.query<{
    name: string;
    class_name: string;
    code: string;
    access_mode: AccessMode;
  }>(
    `SELECT name, class_name, code, access_mode
       FROM app_durable_objects
      WHERE app_id = $1 AND status IN ('PENDING', 'BUILDING', 'READY')
      ORDER BY name`,
    [sourceAppId],
  );
  const keysRes = await sourceDb.query<{ key: string }>(
    `SELECT key FROM app_do_env_vars WHERE app_id = $1 ORDER BY key`,
    [sourceAppId],
  );
  const doEnvKeys = keysRes.rows.map((r) => r.key);

  if (src.rows.length === 0) {
    return { cloned: [], do_env_keys: doEnvKeys };
  }

  // Insert every source class into the dest at status='BUILDING'. On conflict
  // (a re-run of a partially-completed clone) refresh the code and drop to
  // BUILDING so the deploy below repairs the state.
  const insertedIds: string[] = [];
  for (const row of src.rows) {
    const codeSha = sha256(row.code);
    const ins = await destDb.query<{ id: string }>(
      `INSERT INTO app_durable_objects (app_id, name, class_name, code, code_sha, access_mode, status, deployed_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'BUILDING', $7)
       ON CONFLICT (app_id, name) DO UPDATE
         SET class_name = EXCLUDED.class_name,
             code = EXCLUDED.code,
             code_sha = EXCLUDED.code_sha,
             access_mode = EXCLUDED.access_mode,
             status = 'BUILDING',
             error_message = NULL,
             updated_at = now()
       RETURNING id`,
      [destAppId, row.name, row.class_name, row.code, codeSha, row.access_mode, destUserId],
    );
    insertedIds.push(ins.rows[0].id);
  }

  try {
    await bundleAndDeploy(destDb, controlDb, destAppId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    await destDb.query(
      `UPDATE app_durable_objects
          SET status = 'ERROR', error_message = $1, updated_at = now()
        WHERE id = ANY($2::uuid[])`,
      [msg, insertedIds],
    );
    throw err;
  }

  await destDb.query(
    `UPDATE app_durable_objects
        SET status = 'READY', error_message = NULL,
            last_deployed_at = now(), updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [insertedIds],
  );

  return { cloned: src.rows.map((r) => r.name), do_env_keys: doEnvKeys };
}

// CF binding name pattern: identifier-like, uppercase by convention.
const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

export interface SetDoEnvResult {
  redeployed: boolean;
}

/**
 * Upsert a single env var and (if any DO classes are active) redeploy the
 * Worker so the new value is visible to instances. Without the redeploy the
 * change would silently sit in the DB until the next class deploy.
 */
export async function setDoEnvVar(
  db: Pool,
  controlDb: Pool,
  appId: string,
  key: string,
  value: string,
): Promise<SetDoEnvResult> {
  const reserved = validateEnvKeys([key]);
  if (reserved) {
    throw new DurableObjectError(
      `Reserved key: "${reserved.key}" — keys starting with BUTTERBASE_ are reserved for platform use`,
      'RESERVED_ENV_KEY',
    );
  }
  if (!ENV_KEY_REGEX.test(key)) {
    throw new DurableObjectError(
      `Invalid env var key '${key}'. Must match ${ENV_KEY_REGEX} (uppercase, digits, underscore).`,
      'INVALID_ENV_KEY',
    );
  }
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  const encrypted = encrypt(value, encKey);

  await db.query(
    `INSERT INTO app_do_env_vars (app_id, key, encrypted_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_id, key) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value,
           updated_at = now()`,
    [appId, key, encrypted],
  );

  return { redeployed: await maybeRedeploy(db, controlDb, appId) };
}

export async function deleteDoEnvVar(
  db: Pool,
  controlDb: Pool,
  appId: string,
  key: string,
): Promise<SetDoEnvResult> {
  await db.query(`DELETE FROM app_do_env_vars WHERE app_id = $1 AND key = $2`, [appId, key]);
  return { redeployed: await maybeRedeploy(db, controlDb, appId) };
}

async function maybeRedeploy(db: Pool, controlDb: Pool, appId: string): Promise<boolean> {
  const active = await loadActiveClasses(db, appId);
  if (active.length === 0) return false;
  await bundleAndDeploy(db, controlDb, appId, active);
  return true;
}

/**
 * Redeploys the app's DO Worker if any classes are currently active. Returns
 * true when a redeploy actually ran, false when the app has no DOs. Errors bubble.
 */
export async function redeployIfActive(
  db: Pool,
  controlDb: Pool,
  appId: string,
): Promise<boolean> {
  return maybeRedeploy(db, controlDb, appId);
}

export async function getDurableObjectUsage(
  db: Pool,
  appId: string,
  _name: string,
  periodStart: string,
): Promise<DurableObjectUsage> {
  const r = await db.query(
    `SELECT meter_type, quantity FROM usage_meters
     WHERE app_id = $1 AND meter_type IN ('do_requests', 'do_cpu_ms')
       AND period_start = $2`,
    [appId, periodStart],
  );
  const result: DurableObjectUsage = { do_requests: 0, do_cpu_ms: 0 };
  for (const row of r.rows as Array<{ meter_type: keyof DurableObjectUsage; quantity: number | string }>) {
    result[row.meter_type] = Number(row.quantity);
  }
  return result;
}
