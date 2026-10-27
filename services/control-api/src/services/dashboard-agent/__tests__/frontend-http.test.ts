/**
 * `frontend-http.ts` — the operator's deploy transport.
 *
 * Two things are being pinned, and only one of them is the happy path.
 *
 * The FUNCTIONAL half: the three calls `deploy.ts` makes must reach the right
 * routes with the right bodies. The snake_case -> camelCase translation is the
 * one with teeth: the route parses `startSchema`, whose `lockfileHash` is a
 * required `/^[a-f0-9]{8,64}$/`, so passing `lockfile_hash` straight through
 * produces a zod 400 that reads like a broken build.
 *
 * The SECURITY half: this object routes around `turnMcp`, which is the loop's
 * policy gate. Its safety rests entirely on being narrow — one tool, three
 * actions. If it ever answers a fourth thing, it stops being a deploy
 * transport and becomes a general-purpose hole through which any caller
 * reaches any tool with the org's key and no policy check. Those tests are not
 * ceremony; they are the control.
 */
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { createHttpFrontendMcp } from '../frontend-http.js';
import { executeApprovedOperatorTool } from '../substrate-approval-bridge.js';
import { captureApprovalOperation, workingTreeArtifact } from '../approval-operation.js';
import { WorkingTreeCache } from '../working-tree.js';

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
  return { impl: impl as unknown as typeof fetch, calls };
}

const mk = (f: ReturnType<typeof fakeFetch>) =>
  createHttpFrontendMcp({ baseUrl: 'http://api.test', fetchImpl: f.impl });

describe('the three calls deploy.ts actually makes', () => {
  it('create_from_source POSTs the from-source route and returns its body', async () => {
    const f = fakeFetch(() => ({ status: 201, body: { deployment_id: 'dep_1', upload_url: 'https://r2/put' } }));
    const res = await mk(f).call('manage_frontend', { action: 'create_from_source', app_id: APP }, JWT);

    expect(res).toEqual({ deployment_id: 'dep_1', upload_url: 'https://r2/put' });
    expect(f.calls[0].url).toBe(`http://api.test/v1/${APP}/frontend/deployments/from-source`);
    expect(f.calls[0].method).toBe('POST');
    expect(f.calls[0].auth).toBe(`Bearer ${JWT}`);
  });

  /**
   * The translation. `deploy.ts` sends the MCP tool's snake_case names; the
   * route parses camelCase and REQUIRES `lockfileHash`. Getting this wrong is
   * a 400 that reads like a build failure.
   */
  it('start_from_source translates snake_case to the camelCase the route parses', async () => {
    const f = fakeFetch(() => ({ body: { ok: true } }));
    await mk(f).call('manage_frontend', {
      action: 'start_from_source',
      app_id: APP,
      deployment_id: 'dep_1',
      lockfile_hash: 'abc123def456',
      build_command: 'npm run build',
      output_dir: 'dist',
      package_manager: 'npm',
    }, JWT);

    expect(f.calls[0].url).toBe(`http://api.test/v1/${APP}/frontend/deployments/from-source/dep_1/start`);
    expect(f.calls[0].body).toEqual({
      buildCommand: 'npm run build',
      outputDir: 'dist',
      packageManager: 'npm',
      lockfileHash: 'abc123def456',
    });
    // The snake names must NOT survive — zod would reject the body.
    expect(f.calls[0].body).not.toHaveProperty('lockfile_hash');
    expect(f.calls[0].body).not.toHaveProperty('build_command');
  });

  it('omits userEnv entirely rather than sending an empty object', async () => {
    const f = fakeFetch(() => ({ body: {} }));
    await mk(f).call('manage_frontend', {
      action: 'start_from_source', app_id: APP, deployment_id: 'd', lockfile_hash: 'aaaaaaaa',
    }, JWT);
    expect(f.calls[0].body).not.toHaveProperty('userEnv');
  });

  it('list_deployments GETs and returns the deployments array', async () => {
    const f = fakeFetch(() => ({ body: { deployments: [{ id: 'dep_1', status: 'live', url: 'https://x' }] } }));
    const res = await mk(f).call('manage_frontend', { action: 'list_deployments', app_id: APP }, JWT);

    expect(res.deployments[0].status).toBe('live');
    expect(f.calls[0].method).toBe('GET');
  });

  it('percent-encodes ids rather than interpolating them raw', async () => {
    const f = fakeFetch(() => ({ body: {} }));
    await mk(f).call('manage_frontend', {
      action: 'start_from_source', app_id: 'app/../evil', deployment_id: 'a b', lockfile_hash: 'aaaaaaaa',
    }, JWT);
    expect(f.calls[0].url).toContain('app%2F..%2Fevil');
    expect(f.calls[0].url).toContain('/a%20b/start');
  });
});

describe('narrowness — this is the security control, not ceremony', () => {
  it('refuses any tool that is not manage_frontend', async () => {
    const f = fakeFetch();
    for (const name of ['manage_repo', 'manage_app', 'select_rows', 'deploy_function']) {
      await expect(mk(f).call(name, { app_id: APP }, JWT)).rejects.toThrow(/manage_frontend only/);
    }
    expect(f.impl).not.toHaveBeenCalled();
  });

  /**
   * `manage_frontend` has actions well beyond the three the deployer needs —
   * env-var writes and deletes among them. Serving them here would hand the
   * operator an ungated path to them.
   */
  it('refuses manage_frontend actions the deployer does not use', async () => {
    const f = fakeFetch();
    for (const action of ['set_env', 'delete', 'rollback', 'get_deployment', undefined]) {
      await expect(mk(f).call('manage_frontend', { action, app_id: APP }, JWT))
        .rejects.toThrow(/refusing manage_frontend action/);
    }
    expect(f.impl).not.toHaveBeenCalled();
  });

  it('requires an app_id, so a missing one cannot become a path traversal', async () => {
    const f = fakeFetch();
    await expect(mk(f).call('manage_frontend', { action: 'list_deployments' }, JWT))
      .rejects.toThrow(/app_id is required/);
    expect(f.impl).not.toHaveBeenCalled();
  });
});

/**
 * A hung create/start/list leg is a real production failure mode: the approval
 * request has no response boundary, the build job sits PENDING, and the owner
 * sees a blank gateway error. Every request needs a bound, and a timed-out one
 * must say so rather than surfacing a bare "aborted".
 */
describe('requests are bounded', () => {
  /** A fetch that only settles when the request signal aborts — like a black-holed socket. */
  function hangingFetch(): typeof fetch {
    return vi.fn((_url: any, init: any = {}) => new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit).signal;
      if (!signal) return;
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('This operation was aborted', 'AbortError')),
        { once: true },
      );
    })) as unknown as typeof fetch;
  }

  it('bounds start_from_source and names the route it gave up on', async () => {
    const mcp = createHttpFrontendMcp({
      baseUrl: 'http://api.test',
      fetchImpl: hangingFetch(),
      startTimeoutMs: 20,
    });

    await expect(
      mcp.call('manage_frontend', {
        action: 'start_from_source',
        app_id: APP,
        deployment_id: 'dep_1',
        lockfile_hash: 'aaaaaaaa',
      }, JWT),
    ).rejects.toThrow(/\/start timed out after 20ms/);
  });

  it('bounds the other calls at the request timeout', async () => {
    const mcp = createHttpFrontendMcp({
      baseUrl: 'http://api.test',
      fetchImpl: hangingFetch(),
      requestTimeoutMs: 20,
    });

    await expect(
      mcp.call('manage_frontend', { action: 'list_deployments', app_id: APP }, JWT),
    ).rejects.toThrow(/frontend GET .*timed out after 20ms/);
  });
});

describe('failures surface as errors, not as silent success', () => {
  it('throws with the status and body on a non-2xx', async () => {
    const f = fakeFetch(() => ({ status: 409, body: { error: { message: 'source zip missing' } } }));
    await expect(mk(f).call('manage_frontend', {
      action: 'start_from_source', app_id: APP, deployment_id: 'd', lockfile_hash: 'aaaaaaaa',
    }, JWT)).rejects.toThrow(/failed \(409\).*source zip missing/s);
  });

  /**
   * A 204/empty body must not throw a JSON parse error that hides the fact the
   * call actually succeeded.
   */
  it('tolerates an empty body on success', async () => {
    const f = fakeFetch(() => ({ status: 204 }));
    await expect(mk(f).call('manage_frontend', { action: 'list_deployments', app_id: APP }, JWT))
      .resolves.toBeNull();
  });
});

/**
 * Task 8 — the approval boundary sits IN FRONT of this transport.
 *
 * The transport routes around `turnMcp`, so its own narrowness is not the
 * whole story: an approved `deploy_frontend` replays through here with the
 * approving human's JWT. What must never happen is that a build the owner did
 * NOT approve is shipped because the working tree moved after the proposal.
 * The executor rebuilds the artifact identity from the CURRENT tree and
 * refuses on any difference — before this transport is constructed, before
 * any fetch, before the advisory lock.
 *
 * The pool is a stub on purpose: a correct refusal happens strictly ahead of
 * every database touch, which is part of the property being pinned.
 */
describe('a changed approval never reaches the deploy transport', () => {
  it('refuses with approval_operation_changed and makes no HTTP call', async () => {
    const cache = new WorkingTreeCache();
    cache.write('conv-1', APP, 'src/App.tsx', 'artifact A');
    const artifactA = workingTreeArtifact(APP, cache.get('conv-1', APP))!;
    expect(artifactA).toBeDefined();

    // The tree changes BEFORE the owner's click.
    cache.write('conv-1', APP, 'src/App.tsx', 'artifact B');

    const fetchMock = vi.fn();
    const prevFetch = global.fetch;
    global.fetch = fetchMock as unknown as typeof fetch;
    try {
      const result = await executeApprovedOperatorTool({} as pg.Pool, {
        approvalId: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
        name: 'deploy_frontend',
        args: { app_id: APP },
        jwt: JWT,
        orgId: '11111111-1111-4111-8111-111111111111',
        approval: {
          conversationId: 'conv-1',
          approvedOperation: captureApprovalOperation({
            toolName: 'deploy_frontend',
            args: { app_id: APP },
            artifact: artifactA,
          }),
        },
        officeConsequential: true,
        cache,
      });

      expect(result).toMatchObject({ ok: false, code: 'approval_operation_changed' });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = prevFetch;
    }
  });
});
