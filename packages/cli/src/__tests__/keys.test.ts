import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keysGenerateCommand } from '../commands/keys.js';

vi.mock('../lib/api-client.js', () => ({
  generateApiKey: vi.fn(async (args: any) => ({
    key: 'bb_sk_test',
    keyId: 'key_test',
    name: args.name,
    prefix: 'bb_sk_test01',
  })),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));

vi.mock('ora', () => ({
  default: () => ({
    start: () => ({ succeed: () => {}, fail: () => {}, stop: () => {} }),
  }),
}));

vi.mock('prompts', () => ({ default: vi.fn() }));

describe('keys generate command', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  beforeEach(() => {
    errSpy.mockClear();
    logSpy.mockClear();
    exitSpy.mockClear();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits JSON with app-scoped result when --scope app + --app are passed', async () => {
    await keysGenerateCommand('foo', { scope: 'app', app: 'app_abc123', json: true });
    const out = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(out).toContain('bb_sk_test');
    expect(out).toContain('key_test');
  });

  it('exits 2 with --app missing for --scope app (and no bb.config)', async () => {
    await expect(
      keysGenerateCommand('foo', { scope: 'app', json: true })
    ).rejects.toThrow('process.exit(2)');
    const errOut = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOut).toMatch(/--app/);
  });

  it('exits 2 with migration message for legacy --scope ai:gateway', async () => {
    await expect(
      keysGenerateCommand('foo', { scope: 'ai:gateway' as any, json: true })
    ).rejects.toThrow('process.exit(2)');
    const errOut = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOut).toMatch(/--extra-scope/);
  });

  it('exits 2 when --app is passed with --scope account', async () => {
    await expect(
      keysGenerateCommand('foo', { scope: 'account', app: 'app_abc', json: true })
    ).rejects.toThrow('process.exit(2)');
    const errOut = errSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOut).toMatch(/only valid with --scope app/);
  });
});
