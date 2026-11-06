import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';

describe('MCP runtime lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('importing the server factory never starts network calls or timers', async () => {
    vi.resetModules();
    vi.stubEnv('CONTROL_DB_URL', 'postgres://synthetic.invalid/never-connect');
    const fetch = vi.fn().mockRejectedValue(new Error('network forbidden'));
    vi.stubGlobal('fetch', fetch);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const connect = vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(() => { throw new Error('DB forbidden'); });
    await import('../create-server.js');
    const registry = await import('../tool-registry.js');
    const validation = await import('../tool-validation.js');
    const server = await registry.createRegisteredToolServer();
    expect(await validation.createRegisteredToolValidator(server).validate('manage_app', { action: 'list' }))
      .toEqual({ toolName: 'manage_app', args: { action: 'list' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('starts the runtime once across explicit startup and multiple runtime servers', async () => {
    vi.resetModules();
    vi.stubEnv('CONTROL_DB_URL', 'postgres://synthetic.invalid/never-connect');
    const poll = vi.fn();
    const listen = vi.fn(async () => ({ stop() {} }));
    vi.doMock('../active-window-cache.js', () => ({ startActiveWindowPoller: poll, isActiveWindowCached: () => false }));
    vi.doMock('../eligibility-listener.js', () => ({ startActiveWindowListener: listen }));
    try {
      const runtime = await import('../create-server.js');
      expect(poll).not.toHaveBeenCalled();
      expect(listen).not.toHaveBeenCalled();
      runtime.startButterbaseMcpRuntime();
      runtime.startButterbaseMcpRuntime();
      await runtime.createButterbaseMcpServer();
      await runtime.createButterbaseMcpServer();
      expect(poll).toHaveBeenCalledTimes(1);
      expect(listen).toHaveBeenCalledExactlyOnceWith('postgres://synthetic.invalid/never-connect');
    } finally {
      vi.doUnmock('../active-window-cache.js');
      vi.doUnmock('../eligibility-listener.js');
    }
  });
});
