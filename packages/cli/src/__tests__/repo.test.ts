// submodules/butterbase-oss/packages/cli/src/__tests__/repo.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { repoInitCommand, repoPushCommand, repoPullCommand, repoStatusCommand } from '../commands/repo.js';
import { cloneCommand } from '../commands/clone.js';

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

  it('repo push: retries once on 409 missing_shas, then succeeds', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'app_x' });
    await fs.outputFile(path.join(tmpDir, 'a.txt'), 'hello\n');

    const calls: string[] = [];
    let commitAttempt = 0;
    mockFetch(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/repo/snapshots/prepare')) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          snapshot_id: 'snap_rt',
          total_bytes: 6,
          file_count: 1,
          missing_blobs: body.files.map((f: any) => ({ sha256: f.sha256, uploadUrl: `https://s3.test/put/${f.sha256}` })),
        }), { status: 200 });
      }
      if (url.startsWith('https://s3.test/put/')) return new Response('', { status: 200 });
      if (url.endsWith('/repo/snapshots/commit')) {
        commitAttempt++;
        if (commitAttempt === 1) {
          const sha = sha256('hello\n');
          return new Response(JSON.stringify({
            error: { code: 'VALIDATION_INVALID_SCHEMA', message: 'Commit blocked', remediation: 'Retry', details: { missing_shas: [sha], size_mismatches: [] } },
          }), { status: 409 });
        }
        return new Response(JSON.stringify({ snapshot_id: 'snap_rt', total_bytes: 6, file_count: 1 }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await repoPushCommand({});

    expect(calls.filter(c => c.includes('/repo/snapshots/prepare'))).toHaveLength(2);  // initial + retry
    expect(calls.filter(c => c.includes('/repo/snapshots/commit'))).toHaveLength(2);
    expect(calls.filter(c => c.startsWith('PUT https://s3.test/put/'))).toHaveLength(2);  // initial + re-upload
    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.pinned_snapshot_id).toBe('snap_rt');
  });

  it('repo push: exits 1 if commit still 409 after retry', async () => {
    await fs.outputJson(path.join(tmpDir, '.butterbase/config.json'), { currentApp: 'app_x' });
    await fs.outputFile(path.join(tmpDir, 'a.txt'), 'hello\n');

    mockFetch(async (url, init) => {
      if (url.endsWith('/repo/snapshots/prepare')) {
        const body = JSON.parse(init.body);
        return new Response(JSON.stringify({
          snapshot_id: 'snap_x', total_bytes: 6, file_count: 1,
          missing_blobs: body.files.map((f: any) => ({ sha256: f.sha256, uploadUrl: `https://s3.test/put/${f.sha256}` })),
        }), { status: 200 });
      }
      if (url.startsWith('https://s3.test/put/')) return new Response('', { status: 200 });
      if (url.endsWith('/repo/snapshots/commit')) {
        const sha = sha256('hello\n');
        return new Response(JSON.stringify({
          error: { code: 'VALIDATION_INVALID_SCHEMA', message: 'still missing', remediation: 'Retry', details: { missing_shas: [sha], size_mismatches: [] } },
        }), { status: 409 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await repoPushCommand({});

    expect(exitSpy).toHaveBeenCalledWith(1);
    // Pin should NOT have been updated.
    const cfg = await fs.readJson(path.join(tmpDir, '.butterbase/config.json'));
    expect(cfg.pinned_snapshot_id).toBeUndefined();
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
    const jsonCall = logSpy.mock.calls
      .map((c: any[]) => String(c[0] ?? ''))
      .find(s => s.trim().startsWith('{'));
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall!);
    const states: Record<string, string> = Object.fromEntries(parsed.files.map((f: any) => [f.path, f.state]));
    expect(states['modified.txt']).toBe('modified');
    expect(states['untracked.txt']).toBe('untracked');
    expect(states['wasDeletedLocally.txt']).toBe('deleted');
    expect(states['deletedOnRemote.txt']).toBe('new');
  });
});

describe('butterbase clone', () => {
  let tmpDir: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-clone-test-'));
    prevCwd = process.cwd();
    process.chdir(tmpDir);

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

  it('clone: creates job, polls, then init+pull lands files', async () => {
    const sha = createHash('sha256').update('hello\n').digest('hex');
    let pollCount = 0;

    mockFetch(async (url, init) => {
      // POST /v1/templates/app_src/clone → job created
      if (url.endsWith('/templates/app_src/clone') && init?.method === 'POST') {
        return new Response(JSON.stringify({ job_id: 'cj_1', status: 'pending' }), { status: 200 });
      }
      // GET /v1/clone-jobs/cj_1 → processing first, then completed
      if (url.endsWith('/clone-jobs/cj_1')) {
        pollCount++;
        if (pollCount === 1) {
          return new Response(JSON.stringify({ job_id: 'cj_1', status: 'processing', source_app_id: 'app_src', dest_app_id: null, retry_count: 0, error_message: null, created_at: '', completed_at: null }), { status: 200 });
        }
        return new Response(JSON.stringify({ job_id: 'cj_1', status: 'completed', source_app_id: 'app_src', dest_app_id: 'app_dest', retry_count: 0, error_message: null, created_at: '', completed_at: '' }), { status: 200 });
      }
      // GET /v1/app_dest/repo/snapshots/latest → snapshot with one file
      if (url.endsWith('/app_dest/repo/snapshots/latest')) {
        return new Response(JSON.stringify({
          snapshot_id: 'snap1',
          manifest: { files: [{ path: 'a.txt', sha256: sha, size: 6 }] },
        }), { status: 200 });
      }
      // GET /v1/app_dest/repo/blobs/<sha> → download URL
      if (url.includes('/app_dest/repo/blobs/')) {
        return new Response(JSON.stringify({ sha256: sha, size: 6, downloadUrl: 'https://s3.test/x', expiresIn: 3600 }), { status: 200 });
      }
      // GET presigned download URL → file content
      if (url === 'https://s3.test/x') {
        return new Response('hello\n', { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const targetDir = path.join(tmpDir, 'cloned');
    await cloneCommand('app_src', targetDir, {});

    expect(await fs.readFile(path.join(targetDir, 'a.txt'), 'utf8')).toBe('hello\n');
    const cfg = await fs.readJson(path.join(targetDir, '.butterbase/config.json'));
    expect(cfg.currentApp).toBe('app_dest');
    expect(cfg.pinned_snapshot_id).toBe('snap1');
  }, 30_000);

  it('clone: exits 1 when job fails', async () => {
    mockFetch(async (url, init) => {
      if (url.endsWith('/templates/app_src/clone') && init?.method === 'POST') {
        return new Response(JSON.stringify({ job_id: 'cj_x', status: 'pending' }), { status: 200 });
      }
      if (url.endsWith('/clone-jobs/cj_x')) {
        return new Response(JSON.stringify({ job_id: 'cj_x', status: 'failed', source_app_id: 'app_src', dest_app_id: null, retry_count: 0, error_message: 'blob missing', created_at: '', completed_at: null }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await cloneCommand('app_src', path.join(tmpDir, 'x'), {});
    expect(exitSpy).toHaveBeenCalledWith(1);
  }, 30_000);

  it('clone --region: forwards region in POST body', async () => {
    const sha = createHash('sha256').update('hi\n').digest('hex');
    let postedBody: any = null;

    mockFetch(async (url, init) => {
      if (url.endsWith('/templates/app_src/clone') && init?.method === 'POST') {
        postedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({ job_id: 'cj_2', status: 'pending' }), { status: 200 });
      }
      if (url.endsWith('/clone-jobs/cj_2')) {
        return new Response(JSON.stringify({ job_id: 'cj_2', status: 'completed', source_app_id: 'app_src', dest_app_id: 'app_r', retry_count: 0, error_message: null, created_at: '', completed_at: '' }), { status: 200 });
      }
      if (url.endsWith('/app_r/repo/snapshots/latest')) {
        return new Response(JSON.stringify({
          snapshot_id: 'snap_r',
          manifest: { files: [{ path: 'hi.txt', sha256: sha, size: 3 }] },
        }), { status: 200 });
      }
      if (url.includes('/app_r/repo/blobs/')) {
        return new Response(JSON.stringify({ sha256: sha, size: 3, downloadUrl: 'https://s3.test/r', expiresIn: 3600 }), { status: 200 });
      }
      if (url === 'https://s3.test/r') {
        return new Response('hi\n', { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    await cloneCommand('app_src', path.join(tmpDir, 'r'), { region: 'eu-west-1' });
    expect(postedBody?.region).toBe('eu-west-1');
  }, 30_000);
});
