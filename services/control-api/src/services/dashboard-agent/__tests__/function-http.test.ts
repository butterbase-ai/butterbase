/**
 * `function-http.ts` — the operator's function-deploy transport.
 *
 * Two things are being pinned, and only one of them is the happy path.
 *
 * The FUNCTIONAL half: the single call `deploy-function.ts` makes must reach
 * `POST /v1/:appId/functions` with `app_id` lifted into the path and the rest
 * of the payload intact. The pass-through is the part with teeth — the route's
 * `deployFunctionSchema` already accepts `envVars`, `timeoutMs`,
 * `memoryLimitMb` and the SINGULAR `trigger` under exactly those names, so any
 * "helpful" reshaping here would fight a shim the route already performs.
 *
 * The SECURITY half: this object routes around `turnMcp`, the loop's policy
 * gate. Its safety rests entirely on being narrow — one tool. If it ever
 * answers a second thing, it stops being a deploy transport and becomes a
 * general-purpose hole through which any caller reaches any tool with the
 * org's key and no policy check. That test is not ceremony; it is the control.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHttpFunctionMcp } from '../function-http.js';

const JWT = 'bb_sk_test';
const APP = 'app_1234';

function fakeFetch(respond: (url: string, init: any) => { status?: number; body?: unknown } = () => ({})) {
  const calls: { url: string; method: string; body: any; auth: string | undefined }[] = [];
  const impl = vi.fn(async (url: any, init: any = {}) => {
    const r = respond(String(url), init);
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : undefined,
      auth: init.headers?.authorization,
    });
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    } as unknown as Response;
  });
  return { impl, calls };
}

const ARGS = {
  app_id: APP,
  name: 'conflicts_check',
  code: 'export async function handler() {}',
  trigger: { type: 'http', config: { method: 'POST', auth: 'none' } },
};

describe('deploy_function over HTTP', () => {
  it('posts to the app-scoped functions route with the org credential', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { id: 'fn_1', url: 'https://api/fn/conflicts_check' } }));
    const mcp = createHttpFunctionMcp({ baseUrl: 'https://api.test', fetchImpl: impl });

    const out = (await mcp.call('deploy_function', ARGS, JWT)) as any;

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`https://api.test/v1/${APP}/functions`);
    expect(calls[0].auth).toBe(`Bearer ${JWT}`);
    // `deploy-function.ts` reads exactly these two fields off the result.
    expect(out).toEqual({ id: 'fn_1', url: 'https://api/fn/conflicts_check' });
  });

  it('lifts app_id into the path and passes everything else through untouched', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { id: 'fn_1' } }));
    const mcp = createHttpFunctionMcp({ baseUrl: 'https://api.test', fetchImpl: impl });

    await mcp.call('deploy_function', { ...ARGS, envVars: { A: '1' }, timeoutMs: 5000, memoryLimitMb: 256 }, JWT);

    expect(calls[0].body).toEqual({
      name: 'conflicts_check',
      code: ARGS.code,
      // Singular `trigger` survives: the ROUTE shims it to a one-element
      // `triggers` array, and doing it here too would be a second shim to keep
      // in sync.
      trigger: ARGS.trigger,
      envVars: { A: '1' },
      timeoutMs: 5000,
      memoryLimitMb: 256,
    });
    expect(calls[0].body).not.toHaveProperty('app_id');
  });

  it('surfaces the status and body when the route rejects the deploy', async () => {
    const { impl } = fakeFetch(() => ({ status: 400, body: { error: 'entry file not found' } }));
    const mcp = createHttpFunctionMcp({ baseUrl: 'https://api.test', fetchImpl: impl });

    // Must throw rather than return a falsy result: `deploy-function.ts` wraps
    // this in try/catch to produce {ok:false,error}, and a silent success would
    // report a function as live that was never deployed.
    await expect(mcp.call('deploy_function', ARGS, JWT)).rejects.toThrow(/400.*entry file not found/);
  });

  it('requires app_id, rather than posting to a malformed path', async () => {
    const { impl, calls } = fakeFetch();
    const mcp = createHttpFunctionMcp({ baseUrl: 'https://api.test', fetchImpl: impl });

    await expect(mcp.call('deploy_function', { name: 'x', code: 'y' }, JWT)).rejects.toThrow(/app_id is required/);
    expect(calls).toHaveLength(0);
  });
});

describe('the blast radius', () => {
  /**
   * The control for the whole file. This transport carries the org's key and
   * performs no policy check, so "one tool only" is the entire security
   * argument.
   */
  it.each(['manage_app', 'deploy_frontend', 'manage_repo', 'manage_substrate'])(
    'refuses %s — it serves deploy_function only',
    async (tool) => {
      const { impl, calls } = fakeFetch();
      const mcp = createHttpFunctionMcp({ baseUrl: 'https://api.test', fetchImpl: impl });

      await expect(mcp.call(tool, { app_id: APP }, JWT)).rejects.toThrow(/serves deploy_function only/);
      expect(calls).toHaveLength(0);
    },
  );
});
