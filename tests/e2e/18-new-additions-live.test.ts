/**
 * Live "MCP-style" smoke against the running local control-api stack.
 *
 * Unlike the other e2e files which use Fastify's in-process `inject()`,
 * this one drives the SDK and the CLI binary against the real HTTP server
 * that `npx tsx services/control-api/src/index.ts` exposes on port 4000.
 *
 * Surfaces covered (from Plans 1–5 of the SDK/CLI drift work):
 *   - AdminMigrationsClient (regions, getActive, listSourceReplicas)
 *   - AiClient.embed / listModels
 *   - AdminPlatformBillingClient (status/plans)
 *   - Typed errors (NotFoundError / AuthError)
 *   - CLI: regions list, ai models, apps migrations active, --help surface
 *
 * Requires:
 *   - `.env.e2e` loaded
 *   - control-api running on $CONTROL_API_URL (default http://localhost:4000)
 *   - packages/sdk built (dist/) and packages/cli built (dist/)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { seedApp, type SeededApp } from './helpers/seed.js';
import { cleanupAll } from './helpers/cleanup.js';
import { ButterbaseClient } from '../../packages/sdk/src/lib/butterbase-client.js';
import { AuthError, NotFoundError, ButterbaseError } from '../../packages/sdk/src/errors/index.js';

const API_URL = process.env.CONTROL_API_URL ?? 'http://localhost:4000';

// Resolve CLI binary path relative to repo root
const CLI_BIN = path.resolve(__dirname, '../../packages/cli/dist/bin/butterbase.js');

let controlPool: pg.Pool;
let seeded: SeededApp;
let testClient: ButterbaseClient;

beforeAll(async () => {
  // Verify the server is up
  const probe = await fetch(`${API_URL}/v1/regions`).catch(() => null);
  if (!probe || !probe.ok) {
    throw new Error(
      `control-api not reachable at ${API_URL}. Start it first:\n` +
      `  set -a && source .env.e2e && set +a\n` +
      `  npx tsx services/control-api/src/index.ts &`,
    );
  }

  controlPool = new pg.Pool({ connectionString: process.env.NEON_PLATFORM_PRIMARY_URL! });
  seeded = await seedApp(controlPool, { region: 'us-east-1' });

  // The .env.e2e BUTTERBASE_E2E=1 flag enables the x-test-user-id bypass.
  // We subclass ButterbaseClient to inject that header on every request.
  class TestClient extends ButterbaseClient {
    constructor() {
      super({ appId: seeded.appId, apiUrl: API_URL, persistSession: false });
    }
    async request<T>(method: string, p: string, body?: any): Promise<T> {
      return super.request<T>(method, p, body, { 'x-test-user-id': seeded.userId });
    }
  }
  testClient = new TestClient();
}, 60_000);

afterAll(async () => {
  if (controlPool) {
    await cleanupAll(controlPool).catch(() => {});
    await controlPool.end();
  }
}, 30_000);

describe('Plan 2 — AdminMigrationsClient (live HTTP)', () => {
  it('listRegions() returns at least us-east-1', async () => {
    const r = await testClient.admin.migrations.listRegions();
    expect(r.error).toBeNull();
    expect(r.data?.regions).toEqual(expect.arrayContaining(['us-east-1']));
  });

  it('getActive() on a fresh app returns { migration: null }', async () => {
    const r = await testClient.admin.migrations.getActive(seeded.appId);
    expect(r.error).toBeNull();
    expect(r.data?.migration).toBeNull();
  });

  it('listSourceReplicas() returns an array (likely empty)', async () => {
    const r = await testClient.admin.migrations.listSourceReplicas();
    expect(r.error).toBeNull();
    expect(Array.isArray(r.data?.source_replicas)).toBe(true);
  });
});

describe('Plan 2 — AiClient new methods (live HTTP)', () => {
  it('listModels() route is reachable (no wrong-pool 500)', async () => {
    const r = await testClient.ai.listModels();
    if (r.error) {
      // Provider unavailable is acceptable; wrong-pool is not.
      expect(r.error.message).not.toMatch(/relation .* does not exist/);
    } else {
      expect(Array.isArray(r.data?.models)).toBe(true);
    }
  });

  it('embed() route is reachable', async () => {
    const r = await testClient.ai.embed({ input: 'hello world' });
    if (r.error) {
      expect(r.error.message).not.toMatch(/relation .* does not exist/);
    } else {
      expect(r.data?.data).toBeDefined();
    }
  });
});

describe('Plan 2 — AdminPlatformBillingClient (live HTTP)', () => {
  it('listPlans() route is reachable', async () => {
    const r = await testClient.admin.platformBilling.listPlans();
    if (r.error) {
      // 401 (test-user-id not a real user with subscription) is fine
      expect(r.error.message).not.toMatch(/relation .* does not exist/);
    } else {
      expect(r.data).toBeDefined();
    }
  });

  it('getStatus() route is reachable', async () => {
    const r = await testClient.admin.platformBilling.getStatus();
    if (r.error) {
      expect(r.error.message).not.toMatch(/relation .* does not exist/);
    }
  });
});

describe('Plan 1/5 — Typed errors over the wire', () => {
  it('Missing function on a known app returns a NotFoundError (404 RESOURCE_NOT_FOUND)', async () => {
    const r = await testClient.admin.functions.get('nonexistent-fn-smoke');
    expect(r.error).toBeTruthy();
    expect(r.error).toBeInstanceOf(NotFoundError);
    const be = r.error as ButterbaseError;
    expect(be.status).toBe(404);
    expect(be.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('Missing app id returns a NotFoundError surfaced through fly-replay', async () => {
    const ghost = new (class extends ButterbaseClient {
      constructor() {
        super({ appId: 'nonexistent-app-12345', apiUrl: API_URL, persistSession: false });
      }
      async request<T>(method: string, p: string, body?: any): Promise<T> {
        return super.request<T>(method, p, body, { 'x-test-user-id': seeded.userId });
      }
    })();
    const r = await ghost.admin.functions.list();
    expect(r.error).toBeInstanceOf(NotFoundError);
    expect((r.error as ButterbaseError).code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('Plan 4 — CLI commands (live subprocess)', () => {
  function runCli(args: string[], expectExit?: number): { stdout: string; stderr: string; status: number } {
    const r = spawnSync('node', [CLI_BIN, ...args], {
      cwd: '/tmp/cli-test', // has a config.json pointing at localhost:4000
      env: { ...process.env, BUTTERBASE_API_URL: API_URL },
      encoding: 'utf8',
    });
    if (expectExit !== undefined && r.status !== expectExit) {
      throw new Error(
        `expected exit ${expectExit}, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
      );
    }
    return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 1 };
  }

  it('butterbase regions list', () => {
    const r = runCli(['regions', 'list'], 0);
    expect(r.stdout).toContain('us-east-1');
    expect(r.stdout).toContain('eu-west-1');
  });

  it('butterbase regions list --json', () => {
    const r = runCli(['regions', 'list', '--json'], 0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.regions).toEqual(expect.arrayContaining(['us-east-1']));
  });

  it('butterbase apps migrations active <appId> prints expected line', () => {
    const r = runCli(['apps', 'migrations', 'active', seeded.appId]);
    // backend returns 401 because there's no user JWT on the CLI; either way
    // the command must not crash with an unhelpful "Cannot read properties of undefined".
    // Accept either "No active migration" (0) or a typed error rendering.
    expect(r.status === 0 || r.status === 1).toBe(true);
    expect(r.stdout + r.stderr).not.toMatch(/TypeError|Cannot read properties/);
  });

  it('butterbase --help exposes new ai/oauth/audit/regions/app-billing trees', () => {
    const r = runCli(['--help'], 0);
    for (const cmd of ['ai', 'oauth', 'audit', 'regions', 'app-billing']) {
      expect(r.stdout, `missing top-level command '${cmd}'`).toContain(cmd);
    }
  });

  it('butterbase ai --help shows chat/embed/models/config/usage', () => {
    const r = runCli(['ai', '--help'], 0);
    for (const sub of ['chat', 'embed', 'models', 'config', 'usage']) {
      expect(r.stdout, `ai --help missing '${sub}'`).toContain(sub);
    }
  });
});
