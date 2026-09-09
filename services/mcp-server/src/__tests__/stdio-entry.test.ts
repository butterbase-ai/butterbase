/**
 * DEFECTS 5 and 6 — the stdio entry point could not start, and polluted the
 * JSON-RPC transport when it did.
 *
 * 5. `src/index.ts` called `loadRegionConfig(process.env)` at import, purely to
 *    print a region in a startup banner, so a client configured with the
 *    DOCUMENTED env (`CONTROL_API_URL` + `BUTTERBASE_API_KEY`) died before the
 *    transport was ever connected:
 *      RegionConfigError: BUTTERBASE_REGIONS env var is not set
 *    A client-side stdio process routes nothing by region — it forwards every
 *    call to CONTROL_API_URL — so config it does not use must not be able to
 *    stop it starting.
 *
 * 6. That banner went to `console.log`, i.e. STDOUT, which IS the JSON-RPC
 *    transport. Tolerant clients skip the stray line; strict ones fail the
 *    handshake.
 *
 * This drives the built `dist/index.js` as a real subprocess rather than
 * importing the module, because both defects are properties of the PROCESS —
 * what it needs in its environment, and what it writes to which file
 * descriptor. Neither is observable from inside the module.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '../../dist/index.js');

/**
 * Start the entry point with ONLY the documented client-side env, send one
 * `initialize` request, and report what each stream carried.
 *
 * PATH is preserved (Windows node needs it) but BUTTERBASE_REGIONS is
 * explicitly deleted: inheriting a developer's shell value would make this
 * test pass for the wrong reason.
 */
function runEntry(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.BUTTERBASE_REGIONS;
    delete env.BUTTERBASE_INSTANCE_REGION;
    env.CONTROL_API_URL = 'http://127.0.0.1:1';
    env.BUTTERBASE_API_KEY = 'bb_sk_test_not_a_real_key';

    const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += String(b); });
    child.stderr.on('data', (b) => { stderr += String(b); });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdio-entry-test', version: '0' },
      },
    })}\n`);

    // The server stays alive on purpose once connected, so end the read side
    // ourselves rather than waiting for an exit that should never come.
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

describe.skipIf(!existsSync(entry))('mcp-server stdio entry', () => {
  it('starts on the documented env alone and keeps stdout pure JSON-RPC', async () => {
    const { stdout, stderr } = await runEntry();

    // DEFECT 5: it used to die here with RegionConfigError before answering.
    expect(stderr).not.toMatch(/RegionConfigError/);
    expect(stderr).not.toMatch(/BUTTERBASE_REGIONS/);

    // DEFECT 6: every line of stdout must parse as JSON. The old banner
    // ("[mcp-server] Starting in region ...") failed exactly this.
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // And the handshake actually completed, so "pure stdout" is not vacuously
    // true by way of the server never replying.
    const first = JSON.parse(lines[0]);
    expect(first.jsonrpc).toBe('2.0');
    expect(first.id).toBe(1);
    expect(first.result?.serverInfo?.name).toBeTruthy();
  }, 20_000);

  it('puts its human-readable startup line on stderr, not stdout', async () => {
    const { stdout, stderr } = await runEntry();
    expect(stderr).toMatch(/\[mcp-server\]/);
    expect(stdout).not.toMatch(/\[mcp-server\]/);
  }, 20_000);
});
