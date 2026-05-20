import { describe, it, expect, vi } from 'vitest';
import { setFlySecret, restartFlyApp } from './fly-secrets.js';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('setFlySecret', () => {
  it('invokes flyctl secrets set with --app and stage flag', async () => {
    (execFile as any).mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(null, 'ok', '');
    });

    await setFlySecret({
      app: 'butterbase-platform',
      key: 'PLATFORM_DB_ACTIVE_SIDE',
      value: 'standby',
      stage: true,
    });

    expect(execFile).toHaveBeenCalledWith(
      'flyctl',
      ['secrets', 'set', '--app', 'butterbase-platform', '--stage', 'PLATFORM_DB_ACTIVE_SIDE=standby'],
      expect.any(Function)
    );
  });

  it('rejects when flyctl exits non-zero', async () => {
    (execFile as any).mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(new Error('flyctl: not found'), '', 'flyctl: not found');
    });

    await expect(
      setFlySecret({ app: 'x', key: 'K', value: 'V', stage: false })
    ).rejects.toThrow(/flyctl/);
  });
});

describe('restartFlyApp', () => {
  it('invokes flyctl apps restart with the app name', async () => {
    (execFile as any).mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(null, 'ok', '');
    });

    await restartFlyApp({ app: 'butterbase-platform' });

    expect(execFile).toHaveBeenCalledWith(
      'flyctl',
      ['apps', 'restart', 'butterbase-platform'],
      expect.any(Function)
    );
  });

  it('rejects when flyctl exits non-zero', async () => {
    (execFile as any).mockImplementation((_cmd: any, _args: any, cb: any) => {
      cb(new Error('not authorized'), '', 'not authorized');
    });

    await expect(
      restartFlyApp({ app: 'x' })
    ).rejects.toThrow(/flyctl apps restart failed/);
  });
});
