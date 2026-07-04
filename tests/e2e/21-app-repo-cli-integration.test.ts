/**
 * E2E — Phase 3 CLI live integration against the running docker-compose stack.
 *
 * Drives the built CLI binary (`node packages/cli/dist/bin/butterbase.js`)
 * against the locally-running rebuilt control-api at http://localhost:4000.
 * Seeds a real platform_users row + apps row + api_keys row in the running
 * databases so the CLI goes through the production bb_sk_ auth path.
 *
 * What this proves the existing in-process e2e suite cannot:
 *   - The packaged CLI binary actually works (no in-process module shortcuts).
 *   - The rebuilt control-api Docker image actually serves Phase 3 routes:
 *       GET  /v1/:app_id/repo/snapshots
 *       POST /v1/:app_id/repo/blobs/batch
 *   - The bb_sk_ → ApiKeyService → repo-auth → runtime-plane apps chain holds
 *     under the real HTTP transport (Traefik / port 4000), not fastify.inject.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import pg from 'pg';

const REPO_ROOT = path.resolve(__dirname, '../../');
const CLI_BIN = path.resolve(REPO_ROOT, 'packages/cli/dist/bin/butterbase.js');

// Docker stack endpoints. Traefik on :80 has no host rule for bare localhost
// → control-api is reached directly on :4000 (the port the container exposes).
const API_URL = 'http://localhost:4000';

// .env.e2e — control-plane DB only; the runtime plane DB lives at :5437 (us).
const CONTROL_DB_URL =
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_DB_URL_US =
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

let seededUserId: string;
let seededAppId: string;
let plaintextApiKey: string;
let tmpHomeDir: string;
let pushedSnapshotId: string;
let workTmpDir: string;

/** Seed user + org_app_index + runtime apps row (mirrors helpers/seed.ts but for the running stack). */
async function seedUserAndApp(): Promise<{ userId: string; appId: string }> {
  const stamp = Date.now() + Math.random().toString(36).slice(2, 6);
  const ownerEmail = `cli-e2e-${stamp}@example.com`;
  const appId = `cli-e2e-app-${stamp}`;
  const subdomain = `cli-e2e-${stamp}`;
  const region = 'us-east-1';

  const u = await controlPool.query<{ id: string }>(
    `INSERT INTO platform_users (id, email, account_status, plan_id)
     VALUES (gen_random_uuid(), $1, 'active', 'launch') RETURNING id`,
    [ownerEmail],
  );
  const userId = u.rows[0].id;

  await controlPool.query(
    `INSERT INTO org_app_index (app_id, organization_id, region) VALUES ($1, (SELECT personal_organization_id FROM platform_users WHERE id = $2), $3)`,
    [appId, userId, region],
  );

  await runtimePool.query(
    `INSERT INTO apps (id, name, owner_id, db_name, subdomain, region, provisioning_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ready')`,
    [appId, `cli-e2e ${stamp}`, userId, `cust_${appId.replace(/-/g, '_')}`, subdomain, region],
  );

  return { userId, appId };
}

/** Mint a bb_sk_ key for the seeded user — matches ApiKeyService.generateApiKey exactly. */
async function seedApiKey(userId: string): Promise<string> {
  const random = randomBytes(20).toString('hex');
  const fullKey = `bb_sk_${random}`;
  const keyHash = createHash('sha256').update(fullKey).digest('hex');
  const keyPrefix = fullKey.substring(0, 12);

  await controlPool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes, scope, substrate_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, keyHash, keyPrefix, 'cli-e2e', ['*'], 'app', userId],
  );

  return fullKey;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], opts: { cwd: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_BIN, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        HOME: tmpHomeDir,
        // The CLI honours these for some commands; harmless to set unconditionally.
        BUTTERBASE_ENDPOINT: API_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  // Sanity: the running control-api is reachable.
  const healthRes = await fetch(`${API_URL}/health`);
  if (!healthRes.ok) {
    throw new Error(`control-api /health unreachable at ${API_URL} — status ${healthRes.status}`);
  }

  // Sanity: the new GET /repo/snapshots route is registered (returns 401 for an unauthenticated probe).
  const probe = await fetch(`${API_URL}/v1/nonexistent/repo/snapshots`, {
    headers: { Authorization: 'Bearer bb_sk_invalid' },
  });
  if (probe.status !== 401 && probe.status !== 404) {
    throw new Error(`/v1/.../repo/snapshots probe returned unexpected ${probe.status}`);
  }

  const seeded = await seedUserAndApp();
  seededUserId = seeded.userId;
  seededAppId = seeded.appId;
  plaintextApiKey = await seedApiKey(seededUserId);

  // CLI HOME — isolated config dir so we don't trample the dev's real ~/.butterbase.
  tmpHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-cli-home-'));
  await fs.ensureDir(path.join(tmpHomeDir, '.butterbase'));
  await fs.writeJson(
    path.join(tmpHomeDir, '.butterbase', 'config.json'),
    { endpoint: API_URL, apiKey: plaintextApiKey, currentApp: seededAppId },
    { spaces: 2 },
  );

  // Project work tmpdir used across init → push → status → log tests.
  workTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-cli-work-'));
}, 60_000);

afterAll(async () => {
  if (controlPool) await controlPool.end();
  if (runtimePool) await runtimePool.end();
  if (tmpHomeDir) await fs.remove(tmpHomeDir).catch(() => {});
  if (workTmpDir) await fs.remove(workTmpDir).catch(() => {});
}, 30_000);

describe('Phase 3 CLI live integration (against rebuilt docker stack)', () => {
  it('repo init writes config + seeds .butterbaseignore', async () => {
    const res = await runCli(['repo', 'init', seededAppId], { cwd: workTmpDir });
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);

    const cfg = await fs.readJson(path.join(workTmpDir, '.butterbase', 'config.json'));
    expect(cfg.currentApp).toBe(seededAppId);
    expect(await fs.pathExists(path.join(workTmpDir, '.butterbaseignore'))).toBe(true);
  }, 60_000);

  it('repo push walks → hashes → uploads → commits; server stores the snapshot', async () => {
    await fs.writeFile(path.join(workTmpDir, 'README.md'), '# hello world\n');
    await fs.ensureDir(path.join(workTmpDir, 'src'));
    await fs.writeFile(path.join(workTmpDir, 'src', 'index.ts'), 'export const x = 1;\n');
    // Ignored by default — must NOT appear in the manifest.
    await fs.ensureDir(path.join(workTmpDir, 'node_modules'));
    await fs.writeFile(path.join(workTmpDir, 'node_modules', 'leak.js'), 'should be ignored\n');

    const res = await runCli(['repo', 'push', '--json'], { cwd: workTmpDir });
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);

    // The JSON line is at the END of stdout — spinners print intermediate non-JSON lines.
    const jsonLine = res.stdout
      .split('\n')
      .reverse()
      .find((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
    // The CLI uses JSON.stringify with 2-space indent, so the body spans multiple lines.
    // Easier: find the first '{' and parse to the matching '}'.
    const firstBrace = res.stdout.indexOf('{');
    expect(firstBrace).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(res.stdout.slice(firstBrace));
    expect(parsed.snapshot_id).toMatch(/^[0-9a-f]{64}$/);
    // 3 = README.md + src/index.ts + .butterbaseignore (seeded by `repo init`).
    // `.butterbase/` and `node_modules/` are both in HARDCODED_IGNORES, so they're excluded.
    expect(parsed.file_count).toBe(3);
    pushedSnapshotId = parsed.snapshot_id;

    // Confirm the server actually has it.
    const latest = await fetch(`${API_URL}/v1/${seededAppId}/repo/snapshots/latest`, {
      headers: { Authorization: `Bearer ${plaintextApiKey}` },
    });
    expect(latest.status).toBe(200);
    const lb = await latest.json() as { snapshot_id: string; manifest: { files: { path: string }[] } };
    expect(lb.snapshot_id).toBe(pushedSnapshotId);
    const paths = lb.manifest.files.map((f) => f.path).sort();
    expect(paths).toEqual(['.butterbaseignore', 'README.md', 'src/index.ts']);
    // jsonLine is referenced to keep the lint clean even though we parse via firstBrace.
    void jsonLine;
  }, 90_000);

  it('repo log lists the new snapshot', async () => {
    const res = await runCli(['repo', 'log', '--json'], { cwd: workTmpDir });
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    const firstBrace = res.stdout.indexOf('{');
    const parsed = JSON.parse(res.stdout.slice(firstBrace)) as { snapshots: { snapshot_id: string }[] };
    expect(parsed.snapshots.map((s) => s.snapshot_id)).toContain(pushedSnapshotId);
  }, 30_000);

  it('repo status reports clean working tree after push', async () => {
    const res = await runCli(['repo', 'status', '--json'], { cwd: workTmpDir });
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    const firstBrace = res.stdout.indexOf('{');
    const parsed = JSON.parse(res.stdout.slice(firstBrace)) as { files: { path: string; state: string }[] };
    expect(parsed.files).toEqual([]);
  }, 30_000);

  it('repo status reports modifications', async () => {
    await fs.writeFile(path.join(workTmpDir, 'README.md'), '# hello world — edited\n');
    const res = await runCli(['repo', 'status', '--json'], { cwd: workTmpDir });
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
    const firstBrace = res.stdout.indexOf('{');
    const parsed = JSON.parse(res.stdout.slice(firstBrace)) as { files: { path: string; state: string }[] };
    const modified = parsed.files.filter((f) => f.state === 'modified');
    expect(modified.length).toBe(1);
    expect(modified[0].path).toBe('README.md');
    // Restore so the pull test below sees the original content on disk re-downloaded.
    await fs.writeFile(path.join(workTmpDir, 'README.md'), '# hello world\n');
  }, 30_000);

  it('repo pull round-trips into a fresh dir', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-cli-pull-'));
    try {
      const initRes = await runCli(['repo', 'init', seededAppId], { cwd: fresh });
      expect(initRes.exitCode, initRes.stdout + initRes.stderr).toBe(0);

      const pullRes = await runCli(['repo', 'pull', '--json'], { cwd: fresh });
      expect(pullRes.exitCode, pullRes.stdout + pullRes.stderr).toBe(0);

      expect(await fs.readFile(path.join(fresh, 'README.md'), 'utf8')).toBe('# hello world\n');
      expect(await fs.readFile(path.join(fresh, 'src', 'index.ts'), 'utf8')).toBe('export const x = 1;\n');

      const cfg = await fs.readJson(path.join(fresh, '.butterbase', 'config.json'));
      expect(cfg.pinned_snapshot_id).toBe(pushedSnapshotId);
    } finally {
      await fs.remove(fresh).catch(() => {});
    }
  }, 90_000);

  it('GET /v1/:app/repo/snapshots and POST /v1/:app/repo/blobs/batch are live on the rebuilt image', async () => {
    // GET list.
    const list = await fetch(`${API_URL}/v1/${seededAppId}/repo/snapshots`, {
      headers: { Authorization: `Bearer ${plaintextApiKey}` },
    });
    expect(list.status).toBe(200);
    const lb = await list.json() as { snapshots: { snapshot_id: string }[] };
    expect(lb.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(lb.snapshots.map((s) => s.snapshot_id)).toContain(pushedSnapshotId);

    // Fetch latest to learn the actual shas in storage.
    const latest = await fetch(`${API_URL}/v1/${seededAppId}/repo/snapshots/latest`, {
      headers: { Authorization: `Bearer ${plaintextApiKey}` },
    });
    const lj = await latest.json() as { manifest: { files: { sha256: string }[] } };
    const shas = lj.manifest.files.map((f) => f.sha256);
    expect(shas.length).toBe(3);

    // POST batch presign.
    const batch = await fetch(`${API_URL}/v1/${seededAppId}/repo/blobs/batch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${plaintextApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ shas }),
    });
    expect(batch.status).toBe(200);
    const bj = await batch.json() as { blobs: { sha256: string; downloadUrl: string; size: number }[] };
    expect(bj.blobs.length).toBe(3);
    for (const b of bj.blobs) {
      expect(b.downloadUrl).toMatch(/^https?:\/\//);
      expect(shas).toContain(b.sha256);
    }
  }, 30_000);

  it('visibility public --listed sets app visibility + listed', async () => {
    const res = await runCli(
      ['visibility', 'public', '--listed', '--app', seededAppId, '--json'],
      { cwd: workTmpDir },
    );
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);

    const r = await runtimePool.query<{ visibility: string; listed: boolean }>(
      `SELECT visibility, listed FROM apps WHERE id = $1`,
      [seededAppId],
    );
    expect(r.rows[0].visibility).toBe('public');
    expect(r.rows[0].listed).toBe(true);
  }, 30_000);

  it('repo wipe -y deletes the repo, subsequent log returns empty', async () => {
    const wipe = await runCli(['repo', 'wipe', '-y'], { cwd: workTmpDir });
    expect(wipe.exitCode, wipe.stdout + wipe.stderr).toBe(0);

    const log = await runCli(['repo', 'log', '--json'], { cwd: workTmpDir });
    expect(log.exitCode, log.stdout + log.stderr).toBe(0);
    const firstBrace = log.stdout.indexOf('{');
    const parsed = JSON.parse(log.stdout.slice(firstBrace)) as { snapshots: unknown[] };
    expect(parsed.snapshots).toEqual([]);
  }, 60_000);
});
