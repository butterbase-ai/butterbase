import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import worker from '../worker.js';

describe('do-invoker bearer auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await SELF.fetch('https://do-invoker.test/invoke', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
  });

  it('returns 401 when bearer is wrong', async () => {
    const res = await SELF.fetch('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });
});

describe('do-invoker dispatch', () => {
  it('returns 400 when x-butterbase-app is missing', async () => {
    const res = await SELF.fetch('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'x-butterbase-class': 'my-do',
        'x-butterbase-instance': 'inst-1',
      },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/x-butterbase-app required/);
  });

  it('dispatches to ${appId}_do via DO_DISPATCH namespace with a rewritten internal URL', async () => {
    // Dispatch-namespace bindings are not simulated by miniflare in
    // vitest-pool-workers, so we invoke worker.fetch directly with a stub
    // env for the dispatch-translation assertions. Auth + header validation
    // are still exercised via SELF above.
    const capturedCalls: { scriptName: string; url: string; headers: Record<string, string> }[] = [];
    const stubEnv = {
      DO_INVOKER_TOKEN: 'test-token',
      DO_DISPATCH: {
        get(scriptName: string) {
          return {
            async fetch(reqOrUrl: Request | string): Promise<Response> {
              const req = typeof reqOrUrl === 'string' ? new Request(reqOrUrl) : reqOrUrl;
              const headers: Record<string, string> = {};
              req.headers.forEach((v, k) => { headers[k] = v; });
              capturedCalls.push({ scriptName, url: req.url, headers });
              return new Response('ok from stub', { status: 200 });
            },
          };
        },
      },
    };

    const req = new Request('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'x-butterbase-app': 'app_abc123',
        'x-butterbase-class': 'support-ticket-do',
        'x-butterbase-instance': 'ticket-42',
        'x-butterbase-internal-caller': 'fn:widget-ingest',
        'x-butterbase-loop-depth': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cmd: 'kick' }),
    });
    const res = await worker.fetch(req, stubEnv as any);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok from stub');
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0].scriptName).toBe('app_abc123_do');
    expect(capturedCalls[0].url).toBe('https://internal.butterbase/_dispatch/support-ticket-do/ticket-42');
    expect(capturedCalls[0].headers['x-butterbase-internal-caller']).toBe('fn:widget-ingest');
    expect(capturedCalls[0].headers['x-butterbase-loop-depth']).toBe('1');
  });

  it('returns 404 when the target script does not exist in the dispatch namespace', async () => {
    const stubEnv = {
      DO_INVOKER_TOKEN: 'test-token',
      DO_DISPATCH: {
        get(_scriptName: string) {
          throw new Error('script not found');
        },
      },
    };
    const req = new Request('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'x-butterbase-app': 'app_missing',
        'x-butterbase-class': 'c',
        'x-butterbase-instance': 'i',
      },
    });
    const res = await worker.fetch(req, stubEnv as any);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/unknown app: app_missing/);
  });

  it('returns 502 when the target script throws at fetch time', async () => {
    const stubEnv = {
      DO_INVOKER_TOKEN: 'test-token',
      DO_DISPATCH: {
        get(_scriptName: string) {
          return {
            async fetch(): Promise<Response> {
              throw new Error('script crashed');
            },
          };
        },
      },
    };
    const req = new Request('https://do-invoker.test/invoke', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'x-butterbase-app': 'app_crashy',
        'x-butterbase-class': 'c',
        'x-butterbase-instance': 'i',
      },
    });
    const res = await worker.fetch(req, stubEnv as any);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/dispatch failed:.*script crashed/);
  });
});
