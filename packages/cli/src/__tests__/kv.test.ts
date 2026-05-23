import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kvGetCommand, kvSetCommand, kvFlushCommand, kvRulesCommand, kvExposeCommand,
  computeDiff, kvApplyCommand,
} from '../commands/kv.js';

describe('butterbase kv', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.BUTTERBASE_API_KEY = 'TK';
    process.env.BUTTERBASE_CONTROL_API_URL = 'https://api.test';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: 'v' }), { status: 200 }),
    );
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('get prints the value', async () => {
    await kvGetCommand('foo', { app: 'app_x' });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/proxy\/app_x\/kv\/foo/);
    expect(logSpy).toHaveBeenCalled();
  });

  it('set sends value + ttl', async () => {
    await kvSetCommand('foo', '{"a":1}', { app: 'app_x', ttl: '60' });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toMatchObject({ value: { a: 1 }, ttl: 60 });
  });

  it('flush without --confirm exits 1', async () => {
    await kvFlushCommand({ app: 'app_x' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rules formats table from {rules:[...]} response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ rules: [{ pattern: 'flags:*', read: 'public', write: 'deny' }] }),
        { status: 200 },
      ),
    );
    await kvRulesCommand({ app: 'app_x' });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/_expose$/);
    const output = (logSpy.mock.calls as string[][]).flat().join(' ');
    expect(output).toMatch(/flags:\*/);
    expect(output).toMatch(/read=public/);
    expect(output).toMatch(/write=deny/);
  });

  it('expose sends PUT with correct body', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));
    await kvExposeCommand('session:*', { app: 'app_x', read: 'public', write: 'deny' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/_expose\/session%3A\*/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toMatchObject({ read: 'public', write: 'deny' });
  });
});

describe('computeDiff', () => {
  const live = [
    { pattern: 'flags:*', read: 'public', write: 'deny' },
    { pattern: 'session:*', read: 'authed', write: 'owner' },
    { pattern: 'old:*', read: 'deny', write: 'deny' },
  ];

  const declared = [
    { pattern: 'flags:*', read: 'public', write: 'deny' },   // unchanged
    { pattern: 'session:*', read: 'public', write: 'deny' }, // changed
    { pattern: 'new:*', read: 'authed', write: 'deny' },     // added
    // old:* is missing -> remove
  ];

  it('classifies add, remove, change correctly', () => {
    const diff = computeDiff(live, declared);
    expect(diff.add).toHaveLength(1);
    expect(diff.add[0].pattern).toBe('new:*');

    expect(diff.remove).toHaveLength(1);
    expect(diff.remove[0].pattern).toBe('old:*');

    expect(diff.change).toHaveLength(1);
    expect(diff.change[0].pattern).toBe('session:*');
    expect(diff.change[0].read).toBe('public');
    expect(diff.change[0].from.read).toBe('authed');
  });

  it('returns empty diff when live and declared match', () => {
    const same = [{ pattern: 'flags:*', read: 'public', write: 'deny' }];
    const diff = computeDiff(same, same);
    expect(diff.add).toHaveLength(0);
    expect(diff.remove).toHaveLength(0);
    expect(diff.change).toHaveLength(0);
  });
});

describe('kvApplyCommand integration', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    process.env.BUTTERBASE_API_KEY = 'TK';
    process.env.BUTTERBASE_CONTROL_API_URL = 'https://api.test';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Create a temp kv.config.ts file
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-apply-test-'));
    configPath = path.join(tmpDir, 'kv.config.ts');
    fs.writeFileSync(
      configPath,
      `export default { expose: [{ pattern: 'flags:*', read: 'public', write: 'deny' }] };`,
    );

    // Default fetch: listRules returns no rules, expose/unexpose return {}
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/_expose') && !u.includes('/_expose/')) {
        return new Response(JSON.stringify({ rules: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    fetchSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies add rules in correct sequence with --yes', async () => {
    await kvApplyCommand({ app: 'app_x', file: configPath, yes: true });

    // First call should be listRules GET /_expose
    const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
    expect(String(calls[0][0])).toMatch(/\/_expose$/);

    // Second call should be expose PUT
    expect(calls[1][1].method).toBe('PUT');
    expect(String(calls[1][0])).toMatch(/\/_expose\/flags%3A\*/);
  });

  it('calls unexpose then expose when rule exists and changes', async () => {
    // Live has flags:* with different settings
    fetchSpy.mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/_expose') && !u.includes('/_expose/')) {
        return new Response(
          JSON.stringify({ rules: [{ pattern: 'flags:*', read: 'authed', write: 'deny' }, { pattern: 'old:*', read: 'deny', write: 'deny' }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await kvApplyCommand({ app: 'app_x', file: configPath, yes: true });

    const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
    // First: listRules
    expect(String(calls[0][0])).toMatch(/\/_expose$/);

    // Should DELETE old:* (remove) and PUT flags:* (change)
    const methods = calls.slice(1).map(([url, init]) => `${init.method} ${String(url).split('/').pop()}`);
    expect(methods).toContain('DELETE old%3A*');
    expect(methods).toContain('PUT flags%3A*');
  });

  it('dry-run prints preview but makes no changes', async () => {
    await kvApplyCommand({ app: 'app_x', file: configPath, dryRun: true });

    const calls = fetchSpy.mock.calls as Array<[string, RequestInit]>;
    // Only the listRules call should have happened
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toMatch(/\/_expose$/);

    const output = (logSpy.mock.calls as string[][]).flat().join(' ');
    expect(output).toMatch(/dry-run/);
  });
});
