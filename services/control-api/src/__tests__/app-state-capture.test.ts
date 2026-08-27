import { describe, it, expect, beforeAll } from 'vitest';
import { canonicalJson, captureAppState } from '../services/app-state-capture.js';
import { encrypt } from '../services/crypto.js';

const TEST_AUTH_ENCRYPTION_KEY = '0'.repeat(63) + '1'; // 64 hex chars = 32 bytes

beforeAll(() => {
  process.env.AUTH_ENCRYPTION_KEY = TEST_AUTH_ENCRYPTION_KEY;
});

describe('canonicalJson', () => {
  it('is stable under key reordering', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested object keys too', () => {
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
});

describe('captureAppState — secret exclusion', () => {
  const SECRETS = [
    'sk_live_SHOULD_NEVER_APPEAR',
    'wsec_SHOULD_NEVER_APPEAR',
    'client_secret_SHOULD_NEVER_APPEAR',
    'composio_SHOULD_NEVER_APPEAR',
  ];

  // Guards against a SELECT ever widening to pull a secret-bearing column.
  // Fixture rows alone only prove "secret-free input produces secret-free
  // output" — they say nothing about whether the SELECT text itself stays
  // secret-free, since captureConfig's oauth/integrations/realtime rows (and
  // the functions rows) are returned wholesale (`oauth.rows`, `.rows`, etc.)
  // with no per-field JS narrowing. Asserting on the query text closes that
  // gap: if a future SELECT ever names one of these columns, the stub throws
  // before fixture data gets a chance to mask it.
  const FORBIDDEN_SQL_COLUMNS = /client_secret_encrypted|composio_auth_config_id|\bclient_id\b/i;

  function poolReturning(rowsByTable: Record<string, unknown[]>) {
    return {
      query: async (sql: string) => {
        if (FORBIDDEN_SQL_COLUMNS.test(sql)) {
          throw new Error(
            `poolReturning: query text references a forbidden secret-bearing column:\n${sql}`,
          );
        }
        const table = Object.keys(rowsByTable).find((t) => sql.includes(t));
        return { rows: table ? rowsByTable[table] : [] };
      },
    } as unknown as import('pg').Pool;
  }

  it('emits no secret value anywhere in the manifest', async () => {
    const runtimePool = poolReturning({
      apps: [{
        storage_config: { total_size_limit: 1000 },
        jwt_config: { ttl: 3600 },
        allowed_origins: ['https://example.com'],
        ai_config: { model: 'anthropic/claude-sonnet-4.5', byokKey: 'sk_live_SHOULD_NEVER_APPEAR' },
        repo_latest_snapshot: 'snap_abc',
      }],
      app_realtime_config: [{ table_name: 'todos', events: ['INSERT'], enabled: true }],
      app_oauth_configs: [{
        provider: 'google', scopes: ['email'], authorization_url: 'https://a',
        token_url: 'https://t', userinfo_url: 'https://u', enabled: true,
        redirect_uris: [], provider_metadata: {},
      }],
      app_integration_configs: [{
        toolkit_slug: 'slack', display_name: 'Slack', enabled: true, scopes: [],
      }],
      app_functions: [{
        name: 'webhook', code: 'export default () => {}', description: null,
        timeout_ms: 30000, memory_limit_mb: 128, agent_tool: false,
        agent_tool_description: null, agent_tool_mode: null,
        agent_tool_exposed_to: null, trigger_type: 'http', trigger_config: {},
      }],
      app_durable_objects: [{ class_name: 'ChatRoom' }],
    });
    const appPool = poolReturning({});

    const manifest = await captureAppState(runtimePool, appPool, 'app_x');
    const serialized = canonicalJson(manifest);
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('client_secret_encrypted');
    expect(serialized).not.toContain('composio_auth_config_id');
  });

  it('captures env var KEY NAMES but never values', async () => {
    const runtimePool = poolReturning({
      apps: [{ repo_latest_snapshot: null }],
      app_do_env_vars: [{ key: 'STRIPE_KEY' }],
    });
    const manifest = await captureAppState(runtimePool, poolReturning({}), 'app_x');
    expect(manifest.required_env.durable_objects).toEqual(['STRIPE_KEY']);
    expect(canonicalJson(manifest)).not.toContain('sk_live');
  });

  it('captures FUNCTION env var KEY NAMES but never decrypted values', async () => {
    const plaintextSecretValue = 'sk_live_SHOULD_NEVER_APPEAR';
    const encryptedBlob = encrypt(
      JSON.stringify({ STRIPE_KEY: plaintextSecretValue }),
      TEST_AUTH_ENCRYPTION_KEY,
    );
    const runtimePool = poolReturning({
      apps: [{ repo_latest_snapshot: null }],
      app_functions: [{
        name: 'webhook', code: 'export default () => {}', description: null,
        timeout_ms: 30000, memory_limit_mb: 128, agent_tool: false,
        agent_tool_description: null, agent_tool_mode: null,
        agent_tool_exposed_to: null, trigger_type: 'http', trigger_config: {},
        encrypted_env_vars: encryptedBlob,
      }],
    });
    const manifest = await captureAppState(runtimePool, poolReturning({}), 'app_x');
    expect(manifest.required_env.functions).toEqual({ webhook: ['STRIPE_KEY'] });
    expect(canonicalJson(manifest)).not.toContain(plaintextSecretValue);
  });
});
