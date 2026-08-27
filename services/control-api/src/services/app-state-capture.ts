import { createHash } from 'node:crypto';
import pg from 'pg';
import { introspectSchema, type IntrospectedSchema } from './schema-introspector.js';
import { introspectRls, type RlsPolicy } from './rls-introspector.js';
import { listSourceEnvVarKeys } from './clone-env-vars.js';
import { listDoEnvVarKeys } from './durable-objects.service.js';

export interface CapturedFunction {
  name: string;
  code: string;
  description: string | null;
  timeout_ms: number;
  memory_limit_mb: number;
  agent_tool: boolean;
  agent_tool_description: string | null;
  agent_tool_mode: string | null;
  agent_tool_exposed_to: string | null;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
}

export interface CapturedConfig {
  storage_config: unknown;
  jwt_config: unknown;
  allowed_origins: unknown;
  ai_config: unknown;
  realtime: { table_name: string; events: unknown; enabled: boolean }[];
  oauth: {
    provider: string; scopes: unknown; authorization_url: string | null;
    token_url: string | null; userinfo_url: string | null; enabled: boolean;
    redirect_uris: unknown; provider_metadata: unknown;
  }[];
  integrations: { toolkit_slug: string; display_name: string | null; enabled: boolean; scopes: unknown }[];
}

export interface AppStateManifest {
  schema: IntrospectedSchema;
  rls: RlsPolicy[];
  functions: CapturedFunction[];
  durable_objects: string[];
  config: CapturedConfig;
  required_env: { functions: Record<string, string[]>; durable_objects: string[] };
  snapshot_id: string | null;
  hashes: { schema: string; rls: string; functions: string; config: string };
}

/**
 * Deterministic JSON with object keys sorted at every depth. Hashes are taken
 * over this, so two captures of an identical app must produce identical bytes
 * regardless of column or row ordering from Postgres.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',');
  return `{${body}}`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function captureConfig(runtimePool: pg.Pool, appId: string): Promise<CapturedConfig> {
  const appRow = await runtimePool.query(
    `SELECT storage_config, jwt_config, allowed_origins, ai_config FROM apps WHERE id = $1`,
    [appId],
  );
  const realtime = await runtimePool.query(
    `SELECT table_name, events, enabled FROM app_realtime_config WHERE app_id = $1 ORDER BY table_name`,
    [appId],
  );
  // client_id and client_secret_encrypted are deliberately absent from this SELECT,
  // mirroring replayOauthConfigs in clone-replay.ts.
  const oauth = await runtimePool.query(
    `SELECT provider, scopes, authorization_url, token_url, userinfo_url,
            enabled, redirect_uris, provider_metadata
       FROM app_oauth_configs WHERE app_id = $1 ORDER BY provider`,
    [appId],
  );
  // composio_auth_config_id is deliberately absent — it references a credential.
  const integrations = await runtimePool.query(
    `SELECT toolkit_slug, display_name, enabled, scopes
       FROM app_integration_configs WHERE app_id = $1 ORDER BY toolkit_slug`,
    [appId],
  );
  const a = appRow.rows[0] ?? {};
  // Strip the BYOK key, mirroring replayAiConfig in clone-replay.ts:744 — a
  // release is readable by anyone who can see the public template, so a
  // manifest carrying this credential would leak it across tenants.
  const { byokKey: _drop, ...aiConfig } = (a.ai_config ?? {}) as Record<string, unknown>;
  return {
    storage_config: a.storage_config ?? null,
    jwt_config: a.jwt_config ?? null,
    allowed_origins: a.allowed_origins ?? null,
    ai_config: aiConfig,
    realtime: realtime.rows,
    oauth: oauth.rows,
    integrations: integrations.rows,
  };
}

/**
 * Freeze an app's non-secret state. Read-only: mutates nothing.
 *
 * NEVER captured: function/DO env var VALUES, OAuth client_id and
 * client_secret_encrypted, integration composio_auth_config_id, meetings wsec_*,
 * signing keys, seed-data rows, the built frontend artifact, runtime counters.
 * A release is readable by anyone who can see the public template, so a manifest
 * carrying values would be a credential leak.
 */
export async function captureAppState(
  runtimePool: pg.Pool,
  appPool: pg.Pool,
  appId: string,
): Promise<AppStateManifest> {
  const [schema, rlsRaw, config] = await Promise.all([
    introspectSchema(appPool),
    introspectRls(appPool),
    captureConfig(runtimePool, appId),
  ]);

  // introspectRls's underlying `pg_policies` query (rls-introspector.ts) has no
  // ORDER BY — deliberately not changed there, since that file is shared with
  // the clone worker's replayRls path and reordering its output has blast
  // radius beyond this task. canonicalJson preserves array order, so without
  // sorting here two captures of an identical app could hash differently
  // depending on how Postgres happens to return the policy rows.
  const rls = [...rlsRaw].sort((a, b) =>
    a.table === b.table ? a.name.localeCompare(b.name) : a.table.localeCompare(b.table),
  );

  const fnRows = await runtimePool.query<CapturedFunction>(
    `SELECT name, code, description, timeout_ms, memory_limit_mb,
            agent_tool, agent_tool_description, agent_tool_mode, agent_tool_exposed_to,
            trigger_type, trigger_config
       FROM app_functions
      WHERE app_id = $1 AND deleted_at IS NULL
      ORDER BY name`,
    [appId],
  );
  const functions = fnRows.rows;

  // app_durable_objects has no deleted_at column — "active" is defined by
  // status (see loadActiveClasses in durable-objects.service.ts), which
  // excludes ERROR and SUPERSEDED rows the same way a soft-delete flag would.
  const doRows = await runtimePool.query<{ class_name: string }>(
    `SELECT class_name FROM app_durable_objects
      WHERE app_id = $1 AND status IN ('PENDING', 'BUILDING', 'READY')
      ORDER BY class_name`,
    [appId],
  );

  const fnEnvKeys: Record<string, string[]> = {};
  try {
    for (const f of await listSourceEnvVarKeys(runtimePool, appId)) {
      fnEnvKeys[f.fn_name] = [...f.keys].sort();
    }
  } catch {
    // Soft-fail: a missing AUTH_ENCRYPTION_KEY or an undecryptable blob must not
    // block a publish. required_env is advisory; an empty map is honest.
  }
  const doEnvKeys = await listDoEnvVarKeys(runtimePool, appId).catch(() => [] as string[]);

  const snapRow = await runtimePool.query<{ repo_latest_snapshot: string | null }>(
    `SELECT repo_latest_snapshot FROM apps WHERE id = $1`,
    [appId],
  );

  return {
    schema, rls, functions,
    durable_objects: doRows.rows.map((r) => r.class_name),
    config,
    required_env: { functions: fnEnvKeys, durable_objects: doEnvKeys },
    snapshot_id: snapRow.rows[0]?.repo_latest_snapshot ?? null,
    hashes: {
      schema: sha256(schema),
      rls: sha256(rls),
      functions: sha256(functions),
      config: sha256(config),
    },
  };
}
