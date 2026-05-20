/**
 * Phase 1 E2E — Boot-time region config assertions
 *
 * Verifies that the control-api fails fast (non-zero exit + meaningful stderr)
 * when required region/Neon env vars are missing at startup.
 *
 * Implementation notes:
 * - Uses spawn() so the child process gets a CLEAN env (no leaked parent vars).
 * - `npx tsx -e` works fine on Node 24 with spawn (ENOENT only happens if PATH
 *   is not forwarded; we forward PATH explicitly).
 * - Module-level code in services/control-api/src/index.ts calls
 *   assertRegionConfig() and assertNeonProjectsConfig() before buildApp() even
 *   runs, so the dynamic import itself rejects with the config error.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Minimal clean env that satisfies all required vars EXCEPT the ones in
 * `envOverride` (pass `undefined` to delete a key).
 */
function bootWithEnv(
  envOverride: Record<string, string | undefined>,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    // Start from a clean slate — only pass the minimum the service needs plus
    // PATH so npx/tsx can be found.
    const base: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      BUTTERBASE_REGIONS: 'us-east-1,eu-west-1',
      BUTTERBASE_REGION: 'us-east-1',
      // Minimal Neon project vars for both regions
      NEON_RUNTIME_PROJECT_ID_US_EAST_1: 'postgresql://x@localhost:5437/runtime_us',
      NEON_RUNTIME_PROJECT_ID_EU_WEST_1: 'postgresql://x@localhost:5438/runtime_eu',
      NEON_DATA_PROJECT_ID_US_EAST_1: 'postgresql://x@localhost:5435/data_us',
      NEON_DATA_PROJECT_ID_EU_WEST_1: 'postgresql://x@localhost:5436/data_eu',
    };

    // Apply overrides; undefined means "delete the key"
    const env: Record<string, string> = { ...base };
    for (const [k, v] of Object.entries(envOverride)) {
      if (v === undefined) {
        delete env[k];
      } else {
        env[k] = v;
      }
    }

    const script = `
      import('./services/control-api/src/index.js')
        .then(m => m.buildApp())
        .then(a => a.ready())
        .then(() => process.exit(0))
        .catch(e => { console.error(e.message); process.exit(1); });
    `;

    const proc = spawn('npx', ['tsx', '-e', script], {
      cwd: REPO_ROOT,
      env,
    });

    let stderr = '';
    proc.stderr.on('data', (b) => { stderr += b.toString(); });
    proc.on('exit', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

describe('Phase 1 — boot config assertions', () => {
  it('fails fast when BUTTERBASE_REGIONS is missing', async () => {
    const r = await bootWithEnv({ BUTTERBASE_REGIONS: undefined });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/region|butterbase_regions/);
  }, 60_000);

  it('fails fast when a per-region Neon runtime project URL is missing', async () => {
    const r = await bootWithEnv({ NEON_RUNTIME_PROJECT_ID_EU_WEST_1: undefined });
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/neon_runtime_project_id|missing|eu/);
  }, 60_000);
});
