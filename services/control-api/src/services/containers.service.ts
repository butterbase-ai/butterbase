// services/control-api/src/services/containers.service.ts
//
// Service layer for the Containers capability (docs/containers.md, M1).
// Mirrors durable-objects.service.ts: rows live in the runtime tier;
// container_images is control-plane (global, ref-counted).
import { Pool } from 'pg';
import { config } from '../config.js';
import * as Cf from './cloudflare-containers.js';
import { buildFrontDoorWorker, toContainerScriptName } from './ctr-front-door.js';
import { decrypt, encrypt } from './crypto.js';

export class ContainerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ContainerError';
  }
}

const NAME_REGEX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const MAX_CONTAINERS_PER_APP = 5;

export interface RegisterContainerInput {
  name: string;
  image_digest: string;                     // 'sha256:...' — must already exist in container_images for this app/name
  mode?: 'pool' | 'actor';
  access_mode?: 'public' | 'authenticated' | 'service_key';
  instance_type?: 'dev' | 'basic' | 'standard';
  max_instances?: number;
  sleep_after_s?: number;
  port?: number;
}

function imageRefFor(repo: string, digest: string): string {
  return `${config.cloudflare.containerRegistryHost}/${config.cloudflare.accountId}/${repo}@${digest}`;
}

async function loadEnvVars(runtimeDb: Pool, containerId: string): Promise<Record<string, string>> {
  const r = await runtimeDb.query<{ key: string; encrypted_value: string }>(
    `SELECT key, encrypted_value FROM app_container_env_vars WHERE container_id = $1`,
    [containerId],
  );
  const encKey = process.env.AUTH_ENCRYPTION_KEY!;
  const out: Record<string, string> = {};
  for (const row of r.rows) out[row.key] = decrypt(row.encrypted_value, encKey);
  return out;
}

function wrapCfError(err: unknown): ContainerError {
  const raw = err instanceof Error ? err.message : String(err);
  return new ContainerError(`Cloudflare rejected the container deploy: ${raw}`, 'CF_DEPLOY_FAILED');
}

export async function registerContainer(
  runtimeDb: Pool,
  controlDb: Pool,
  appId: string,
  userId: string,
  input: RegisterContainerInput,
): Promise<{ id: string; name: string; status: 'READY' }> {
  if (!NAME_REGEX.test(input.name)) {
    throw new ContainerError(
      `Invalid container name: ${input.name}. Must be lowercase kebab-case (e.g. 'game-server').`,
      'INVALID_NAME',
    );
  }

  // Resolve the image BEFORE writing anything — fail fast with a clear error.
  const repo = `${appId}/${input.name}`;
  const img = await controlDb.query(
    `SELECT id, registry_repo, digest FROM container_images WHERE registry_repo = $1 AND digest = $2`,
    [repo, input.image_digest],
  );
  if (img.rows.length === 0) {
    throw new ContainerError(
      `No image ${input.image_digest} found for ${repo}. Push one first: docker push <registry>/${repo}`,
      'IMAGE_NOT_FOUND',
    );
  }
  const image = img.rows[0] as { id: string; registry_repo: string; digest: string };

  const mode = input.mode ?? 'pool';
  const accessMode = input.access_mode ?? 'service_key';
  const instanceType = input.instance_type ?? 'basic';
  const maxInstances = input.max_instances ?? 5;
  const sleepAfterS = input.sleep_after_s ?? 300;
  const port = input.port ?? 8080;

  const count = await runtimeDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app_containers WHERE app_id = $1 AND deleted_at IS NULL AND name <> $2`,
    [appId, input.name],
  );
  if ((count.rows[0]?.n ?? 0) >= MAX_CONTAINERS_PER_APP) {
    throw new ContainerError(`Max ${MAX_CONTAINERS_PER_APP} containers per app.`, 'QUOTA_EXCEEDED');
  }

  // ALL writes to app_containers go through this upsert path (ON CONFLICT DO UPDATE) —
  // never a bare INSERT — so that re-creating a previously soft-deleted name clears
  // deleted_at instead of 409ing on the UNIQUE(app_id,name) constraint.
  // Crash-safety note: a crash between this DEPLOYING upsert and the final READY/ERROR
  // write leaves a stuck DEPLOYING row; re-running registerContainer self-heals it.
  const upsert = await runtimeDb.query(
    `INSERT INTO app_containers
       (app_id, name, mode, image_id, instance_type, max_instances, sleep_after_s, port, access_mode, status, deployed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DEPLOYING', $10)
     ON CONFLICT (app_id, name) DO UPDATE
       SET mode = EXCLUDED.mode,
           image_id = EXCLUDED.image_id,
           instance_type = EXCLUDED.instance_type,
           max_instances = EXCLUDED.max_instances,
           sleep_after_s = EXCLUDED.sleep_after_s,
           port = EXCLUDED.port,
           access_mode = EXCLUDED.access_mode,
           status = 'DEPLOYING',
           error_message = NULL,
           deleted_at = NULL,
           updated_at = now()
     RETURNING id`,
    [appId, input.name, mode, image.id, instanceType, maxInstances, sleepAfterS, port, accessMode, userId],
  );
  const id = upsert.rows[0].id as string;

  try {
    const envVars = await loadEnvVars(runtimeDb, id);
    const prior = await runtimeDb.query<{ exists: boolean }>(
      `SELECT (last_deployed_at IS NOT NULL) AS exists FROM app_containers WHERE id = $1`,
      [id],
    );
    const isFirstDeploy = !(prior.rows[0]?.exists ?? false);

    await Cf.deployContainerWorker({
      scriptName: toContainerScriptName(appId, input.name),
      workerSource: buildFrontDoorWorker({ name: input.name, mode, accessMode, port, sleepAfterS, maxInstances }),
      imageRef: imageRefFor(image.registry_repo, image.digest),
      instanceType,
      maxInstances,
      envVars,
      isFirstDeploy,
    });
  } catch (err) {
    const wrapped = err instanceof ContainerError ? err : wrapCfError(err);
    await runtimeDb.query(
      `UPDATE app_containers SET status = 'ERROR', error_message = $1, updated_at = now() WHERE id = $2`,
      [wrapped.message, id],
    );
    throw wrapped;
  }

  await runtimeDb.query(
    `UPDATE app_containers SET status = 'READY', error_message = NULL, last_deployed_at = now(), updated_at = now() WHERE id = $1`,
    [id],
  );
  return { id, name: input.name, status: 'READY' };
}

export async function listContainers(runtimeDb: Pool, appId: string) {
  const r = await runtimeDb.query(
    `SELECT id, name, mode, image_id, instance_type, max_instances, sleep_after_s, port,
            access_mode, status, error_message, last_deployed_at, created_at, updated_at
     FROM app_containers
     WHERE app_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [appId],
  );
  return r.rows;
}

export async function getContainer(runtimeDb: Pool, appId: string, name: string) {
  const r = await runtimeDb.query(
    `SELECT id, name, mode, image_id, instance_type, max_instances, sleep_after_s, port,
            access_mode, status, error_message, last_deployed_at, created_at, updated_at
     FROM app_containers
     WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
    [appId, name],
  );
  return r.rows[0] ?? null;
}

export async function deleteContainer(
  runtimeDb: Pool,
  controlDb: Pool,
  appId: string,
  name: string,
): Promise<void> {
  const found = await runtimeDb.query(
    `SELECT id, image_id FROM app_containers WHERE app_id = $1 AND name = $2 AND deleted_at IS NULL`,
    [appId, name],
  );
  if (found.rows.length === 0) throw new ContainerError('Container not found', 'NOT_FOUND');
  const row = found.rows[0] as { id: string; image_id: string | null };

  // Delete the CF script BEFORE marking the row deleted, mirroring the DO teardown
  // ordering (never leave the DB claiming gone while CF still serves).
  try {
    await Cf.deleteContainerWorker(toContainerScriptName(appId, name));
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // A 404 from CF means the script is already gone — proceed.
    if (!raw.includes('(404)') && !raw.includes('[10007]')) throw wrapCfError(err);
  }

  // Also clear last_deployed_at: the CF script is now gone, so the next registerContainer
  // must be treated as a first deploy and include migrations.new_sqlite_classes.
  await runtimeDb.query(
    `UPDATE app_containers SET deleted_at = now(), last_deployed_at = NULL, updated_at = now() WHERE id = $1`,
    [row.id],
  );
  if (row.image_id) {
    await controlDb.query(
      `UPDATE container_images SET ref_count = GREATEST(ref_count - 1, 0) WHERE id = $1`,
      [row.image_id],
    );
  }
}

export interface SetEnvResult { redeployed: boolean }

export async function setContainerEnvVar(
  runtimeDb: Pool,
  controlDb: Pool,
  appId: string,
  name: string,
  key: string,
  value: string,
): Promise<SetEnvResult> {
  if (!ENV_KEY_REGEX.test(key)) {
    throw new ContainerError(
      `Invalid env var key '${key}'. Must match ${ENV_KEY_REGEX} (uppercase, digits, underscore).`,
      'INVALID_ENV_KEY',
    );
  }
  if (key === 'CTR') {
    throw new ContainerError(`'CTR' collides with the container binding name.`, 'ENV_BINDING_COLLISION');
  }
  const row = await getContainer(runtimeDb, appId, name);
  if (!row) throw new ContainerError('Container not found', 'NOT_FOUND');

  const encrypted = encrypt(value, process.env.AUTH_ENCRYPTION_KEY!);
  await runtimeDb.query(
    `INSERT INTO app_container_env_vars (container_id, key, encrypted_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (container_id, key) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value, updated_at = now()`,
    [row.id, key, encrypted],
  );
  return { redeployed: await redeployFromRow(runtimeDb, controlDb, appId, row.name) };
}

export async function deleteContainerEnvVar(
  runtimeDb: Pool,
  controlDb: Pool,
  appId: string,
  name: string,
  key: string,
): Promise<SetEnvResult> {
  const row = await getContainer(runtimeDb, appId, name);
  if (!row) throw new ContainerError('Container not found', 'NOT_FOUND');
  await runtimeDb.query(
    `DELETE FROM app_container_env_vars WHERE container_id = $1 AND key = $2`,
    [row.id, key],
  );
  return { redeployed: await redeployFromRow(runtimeDb, controlDb, appId, row.name) };
}

export async function listContainerEnvVarKeys(runtimeDb: Pool, appId: string, name: string): Promise<string[]> {
  const row = await getContainer(runtimeDb, appId, name);
  if (!row) throw new ContainerError('Container not found', 'NOT_FOUND');
  const r = await runtimeDb.query<{ key: string }>(
    `SELECT key FROM app_container_env_vars WHERE container_id = $1 ORDER BY key`,
    [row.id],
  );
  return r.rows.map((x) => x.key);
}

// Redeploy with the row's current config (env change, etc.).
// READY rows only — an in-flight deploy picks up the new value on its own completion path's next deploy.
async function redeployFromRow(runtimeDb: Pool, controlDb: Pool, appId: string, name: string): Promise<boolean> {
  const row = await getContainer(runtimeDb, appId, name);
  if (!row || row.status !== 'READY' || !row.image_id) return false;
  const img = await controlDb.query(
    `SELECT registry_repo, digest FROM container_images WHERE id = $1`,
    [row.image_id],
  );
  if (img.rows.length === 0) return false;
  const envVars = await loadEnvVars(runtimeDb, row.id);
  try {
    await Cf.deployContainerWorker({
      scriptName: toContainerScriptName(appId, name),
      workerSource: buildFrontDoorWorker({
        name, mode: row.mode, accessMode: row.access_mode,
        port: row.port, sleepAfterS: row.sleep_after_s, maxInstances: row.max_instances,
      }),
      imageRef: imageRefFor(img.rows[0].registry_repo, img.rows[0].digest),
      instanceType: row.instance_type,
      maxInstances: row.max_instances,
      envVars,
      isFirstDeploy: false,
    });
  } catch (err) {
    throw wrapCfError(err);
  }
  return true;
}
