import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCliLocale } from '../lib/i18n.js';

vi.mock('../lib/config.js', () => ({
  getMergedConfig: vi.fn().mockResolvedValue({ endpoint: 'http://127.0.0.1:1', apiKey: 'bb_sk_fixture_only', currentApp: 'app_fixture' }),
  getCurrentAppId: vi.fn().mockResolvedValue('app_fixture'),
}));
import { getMergedConfig } from '../lib/config.js';
import { dataQueryCommand, dataInsertCommand } from '../commands/data.js';
import { functionsGetCommand } from '../commands/functions.js';
import { renderError } from '../lib/errors.js';
import { AuthError } from '@butterbase/sdk';

const entry = fileURLToPath(new URL('../../bin/butterbase.ts', import.meta.url));
function cli(args: string[], language?: string) {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.BUTTERBASE_LANG;
  if (language) env.BUTTERBASE_LANG = language;
  return spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { env, encoding: 'utf8', timeout: 10000 });
}

describe('actual CLI locale selection', () => {
  it('keeps default help English, supports the env, and gives the flag precedence', () => {
    const english = cli(['--help']).stdout;
    expect(english).toContain('Usage:');
    expect(english).toContain('choices: "en", "ja"');
    expect(english).toContain('default: "en"');
    expect(english).toContain('env: BUTTERBASE_LANG');
    expect(cli(['functions', 'deploy', '--help']).stdout).toContain('default: "http"');
    const japanese = cli(['--help'], 'ja');
    expect(japanese.status).toBe(0);
    expect(japanese.stdout).toContain('使い方：');
    expect(japanese.stdout).toContain('コマンド：');
    expect(japanese.stdout).toContain('env: BUTTERBASE_LANG');
    expect(cli(['--lang', 'en', '--help'], 'ja').stdout).toContain('Usage:');
  });
  it('supports language after nested commands and retains permission conditions', () => {
    const result = cli(['functions', 'deploy', '--lang', 'ja', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('関数をデプロイ');
    expect(result.stdout).toContain('default: "http"');
    expect(result.stdout).toContain('read_write（人による承認が必要）');
    expect(result.stdout).toContain('X-Butterbase-As-User');
  });
  it('returns errors without running actions for invalid input', () => {
    const missing = cli(['--lang', 'ja', 'functions', 'deploy']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("必須の引数 'file'");
    const unknown = cli(['--lang', 'ja', 'no-such-command']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("不明なコマンド 'no-such-command'");
    expect(cli(['--lang', 'fr', '--help']).status).toBe(1);
  });
});

describe('Japanese display preserves protocol data', () => {
  beforeEach(() => {
    vi.mocked(getMergedConfig).mockResolvedValue({ endpoint: 'http://127.0.0.1:1', apiKey: 'bb_sk_fixture_only', currentApp: 'app_fixture' });
    setCliLocale('ja');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { setCliLocale('en'); vi.restoreAllMocks(); });

  it('keeps GET query parameters and JSON responses byte-for-byte equal', async () => {
    const response = [{ title: 'Cancelled', status: 'public', text: '${0} / 日本語' }];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)));
    await dataQueryCommand('posts', { app: 'app_fixture', filter: ['status=eq.public'], json: true });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:1/v1/app_fixture/posts?status=eq.public');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer bb_sk_fixture_only' });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(JSON.stringify(response, null, 2));
  });
  it('sends user-supplied POST fields unchanged and prints the original JSON', async () => {
    const row = { title: 'Cancelled', status: 'public', command: '--lang ja', note: '${0}' };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(row)));
    await dataInsertCommand('posts', { app: 'app_fixture', data: JSON.stringify(row), json: true });
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(row) });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(JSON.stringify(row, null, 2));
  });
  it('does not translate source code or backend error details', async () => {
    const code = 'export default () => "Cancelled / Fetching agents... / ${0}";\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ name: 'example', code })));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await functionsGetCommand('example', { app: 'app_fixture', sourceOnly: true });
    expect(write).toHaveBeenCalledWith(code);
    const result = renderError(new AuthError('Original backend message', 'AUTH_INVALID_API_KEY', 401, 'Original remediation'));
    expect(result).toContain('Original backend message');
    expect(result).toContain('AUTH_INVALID_API_KEY');
    expect(result).toContain('401');
    expect(result).toContain('Original remediation');
  });
});
