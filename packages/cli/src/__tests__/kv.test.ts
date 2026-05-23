import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { kvGetCommand, kvSetCommand, kvFlushCommand, kvRulesCommand, kvExposeCommand } from '../commands/kv.js';

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
