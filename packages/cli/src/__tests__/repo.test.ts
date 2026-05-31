// submodules/butterbase-oss/packages/cli/src/__tests__/repo.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { repoInitCommand, repoPushCommand, repoPullCommand, repoStatusCommand } from '../commands/repo.js';

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

describe('butterbase repo', () => {
  let tmpDir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-repo-test-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);

    // Isolate global config dir so the test never reads ~/.butterbase/config.json.
    // api-client reads config.endpoint from the global config file; with HOME=tmpDir
    // the file doesn't exist and getBaseUrl() falls back to https://api.butterbase.ai.
    prevHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.BUTTERBASE_API_KEY = 'TK';

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
    process.chdir(prevCwd);
    if (prevHome !== undefined) process.env.HOME = prevHome;
    await fs.remove(tmpDir);
  });

  function mockFetch(handler: (url: string, init?: any) => Promise<Response> | Response) {
    fetchSpy.mockImplementation(async (url: any, init: any) => handler(String(url), init));
  }

  it('repo init creates .butterbase/config.json and a .butterbaseignore', async () => {
    await repoInitCommand('app_123', {});
    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.currentApp).toBe('app_123');
    expect(await fs.pathExists(path.join(tmpDir, '.butterbaseignore'))).toBe(true);
  });

  it('repo init --force overwrites and preserves other fields', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'old', pinned_snapshot_id: 'snap0' });
    await repoInitCommand('app_new', { force: true });
    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.currentApp).toBe('app_new');
    expect(cfg.pinned_snapshot_id).toBe('snap0');  // preserved
  });

  it('repo push: walks, hashes, calls prepare, uploads missing, commits, updates pin', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'app_x' });
    await fs.outputFile(path.join(tmpDir, 'src/a.ts'), 'console.log("a")\n');
    await fs.outputFile(path.join(tmpDir, 'README.md'), '# hi\n');
    // Node_modules content should be ignored by defaults.
    await fs.outputFile(path.join(tmpDir, 'node_modules/leaf/index.js'), 'leak');

    const calls: string[] = [];
    mockFetch(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/repo/snapshots/prepare')) {
        const body = JSON.parse(init.body);
        expect(body.files.map((f: any) => f.path).sort()).toEqual(['README.md', 'src/a.ts']);
        return new Response(JSON.stringify({
          snapshot_id: 'snap_new',
          total_bytes: 30,
          file_count: 2,
          missing_blobs: body.files.map((f: any) => ({ sha256: f.sha256, uploadUrl: `https://s3.test/put/${f.sha256}` })),
        }), { status: 200 });
      }
      if (url.startsWith('https://s3.test/put/')) {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/repo/snapshots/commit')) {
        // commit body is { manifest: { files, message? } } — validated here implicitly
        return new Response(JSON.stringify({ snapshot_id: 'snap_new', total_bytes: 30, file_count: 2 }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await repoPushCommand({});

    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.pinned_snapshot_id).toBe('snap_new');
    expect(calls.filter(c => c.includes('/repo/snapshots/prepare'))).toHaveLength(1);
    expect(calls.filter(c => c.startsWith('PUT https://s3.test/put/'))).toHaveLength(2);
    expect(calls.filter(c => c.includes('/repo/snapshots/commit'))).toHaveLength(1);
  });

  it('repo pull: skips when pinned matches remote', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'app_x', pinned_snapshot_id: 'pin1' });
    mockFetch(async (url) => {
      if (url.endsWith('/repo/snapshots/latest')) {
        return new Response(JSON.stringify({ snapshot_id: 'pin1', manifest: { files: [] } }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await repoPullCommand({});
    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.pinned_snapshot_id).toBe('pin1');
  });

  it('repo pull: downloads new files and applies them', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'app_x' });
    const content = 'hello world\n';
    const sha = sha256(content);
    mockFetch(async (url) => {
      if (url.endsWith('/repo/snapshots/latest')) {
        return new Response(JSON.stringify({
          snapshot_id: 'pin2',
          manifest: { files: [{ path: 'hello.txt', sha256: sha, size: Buffer.byteLength(content) }] },
        }), { status: 200 });
      }
      if (url.includes(`/repo/blobs/${sha}`)) {
        return new Response(JSON.stringify({ sha256: sha, size: Buffer.byteLength(content), downloadUrl: `https://s3.test/get/${sha}`, expiresIn: 3600 }), { status: 200 });
      }
      if (url.startsWith('https://s3.test/get/')) {
        return new Response(content, { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await repoPullCommand({});
    expect(await fs.readFile(path.join(tmpDir, 'hello.txt'), 'utf8')).toBe(content);
    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.pinned_snapshot_id).toBe('pin2');
  });

  it('repo status: prints M / ? / D / N states', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'app_x', pinned_snapshot_id: 'pinold' });
    const unchanged = 'same\n';
    const modifiedLocal = 'NEW LOCAL CONTENT\n';
    await fs.outputFile(path.join(tmpDir, 'unchanged.txt'), unchanged);
    await fs.outputFile(path.join(tmpDir, 'modified.txt'), modifiedLocal);
    await fs.outputFile(path.join(tmpDir, 'untracked.txt'), 'new local file\n');

    mockFetch(async (url) => {
      if (url.endsWith('/repo/snapshots/latest')) {
        // Remote has unchanged + modified (original) + a new file we don't have locally.
        return new Response(JSON.stringify({
          snapshot_id: 'pinnew',
          manifest: { files: [
            { path: 'unchanged.txt', sha256: sha256(unchanged), size: 5 },
            { path: 'modified.txt', sha256: sha256('original\n'), size: 9 },
            { path: 'deletedOnRemote.txt', sha256: sha256('x\n'), size: 2 },  // not in pinned, only in remote — should report as N
          ]},
        }), { status: 200 });
      }
      if (url.includes('/repo/snapshots/pinold')) {
        return new Response(JSON.stringify({
          snapshot_id: 'pinold',
          manifest: { files: [
            { path: 'unchanged.txt', sha256: sha256(unchanged), size: 5 },
            { path: 'modified.txt', sha256: sha256('original\n'), size: 9 },
            { path: 'wasDeletedLocally.txt', sha256: sha256('gone\n'), size: 5 },
          ]},
        }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    await repoStatusCommand({ json: true });
    const stdout = (logSpy.mock.calls.map((c: any[]) => c[0]).join('\n'));
    const parsed = JSON.parse(stdout);
    const states: Record<string, string> = Object.fromEntries(parsed.files.map((f: any) => [f.path, f.state]));
    expect(states['modified.txt']).toBe('modified');
    expect(states['untracked.txt']).toBe('untracked');
    expect(states['wasDeletedLocally.txt']).toBe('deleted');
    expect(states['deletedOnRemote.txt']).toBe('new');
  });
});
