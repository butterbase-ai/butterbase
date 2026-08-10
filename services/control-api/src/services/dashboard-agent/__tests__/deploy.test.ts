import { describe, expect, it, vi } from 'vitest'
import { WorkingTreeCache } from '../working-tree'
import { createDeployer } from '../deploy'
import JSZip from 'jszip'

const CONV = 'c1', APP = 'a1', JWT = 'jwt'

function makeMcp(handlers: Record<string, (args: any) => any>) {
  return { call: vi.fn(async (_: string, args: any) => handlers[args.action](args)) }
}

describe('deploy_frontend', () => {
  it('zips working tree, uploads, starts source build, polls to live', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'package.json', '{"name":"x"}')
    cache.write(CONV, APP, 'src/App.tsx', 'export default () => null')

    const uploadedChunks: Uint8Array[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      uploadedChunks.push(init.body)
      return new Response('', { status: 200 }) as any
    }) as any

    let polls = 0
    const mcp = makeMcp({
      create_from_source: () => ({ deployment_id: 'dep_1', upload_url: 'https://s3/put' }),
      start_from_source: () => ({ deployment_id: 'dep_1', status: 'queued' }),
      list_deployments: () => {
        polls++
        if (polls < 2) return { deployments: [{ id: 'dep_1', status: 'building' }] }
        return { deployments: [{ id: 'dep_1', status: 'live', url: 'https://x.butterbase.dev' }] }
      },
    })

    const progress: any[] = []
    try {
      const d = createDeployer({
        cache, mcp,
        onDeploymentProgress: (e) => progress.push(e),
        pollIntervalMs: 1, maxWaitMs: 5000,
      })
      const r = await d.deploy({ convId: CONV, appId: APP, jwt: JWT })
      expect(r).toMatchObject({ ok: true, deployment_id: 'dep_1', url: 'https://x.butterbase.dev' })
      // Zip contents
      const zip = await JSZip.loadAsync(uploadedChunks[0])
      const pkg = await zip.file('package.json')!.async('string')
      expect(pkg).toBe('{"name":"x"}')
      // Progress statuses observed
      expect(progress.map(p => p.status)).toContain('building')
      expect(progress.map(p => p.status)).toContain('live')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports failed status on build failure', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'package.json', '{}')
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 }) as any) as any
    const mcp = makeMcp({
      create_from_source: () => ({ deployment_id: 'dep_2', upload_url: 'https://s3/put' }),
      start_from_source: () => ({ deployment_id: 'dep_2', status: 'queued' }),
      list_deployments: () => ({ deployments: [{ id: 'dep_2', status: 'failed', error: 'build error' }] }),
    })
    try {
      const d = createDeployer({ cache, mcp, onDeploymentProgress: () => {}, pollIntervalMs: 1, maxWaitMs: 5000 })
      const r = await d.deploy({ convId: CONV, appId: APP, jwt: JWT })
      expect(r).toMatchObject({ ok: false })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/**
 * `deploy()` reports every failure it anticipates as `{ ok: false, error }` —
 * 'no files to deploy', 'upload failed', 'build failed', 'deployment timed
 * out'. A throw out of `deps.mcp.call` was the one path that escaped, and the
 * dispatch site in loop.ts (`const r = await deployer.deploy(...)`) reads
 * `r.ok` with no try/catch, so it killed the whole turn.
 *
 * Observed on a real wake 2026-08-07: the operator got 371 events in and died
 * with `Tool "manage_frontend" is not permitted for the autonomous operator.`
 * `manage_frontend` is internal-only — it is in neither the tool catalogue nor
 * the operator policy table — so it is refused by turnMcp on every operator
 * turn, and the frontend deploy is best-effort anyway. Losing the turn's
 * completed backend work to it is not.
 */
describe('deploy_frontend — a throwing mcp is a failed deploy, not a failed turn', () => {
  it('returns ok:false instead of throwing when manage_frontend is refused', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'package.json', '{"name":"x"}')

    const mcp = {
      call: vi.fn(async () => {
        throw new Error('Tool "manage_frontend" is not permitted for the autonomous operator.')
      }),
    }

    const d = createDeployer({ cache, mcp, onDeploymentProgress: () => {} })
    const r = await d.deploy({ convId: CONV, appId: APP, jwt: JWT })

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/manage_frontend/)
  })
})

/**
 * THE STATUS VOCABULARY, pinned against the producer rather than against what
 * this file used to assume.
 *
 * The tests above poll `'live'` and `'failed'`. Nothing in the platform ever
 * writes those: `build-driver.service.ts` sets 'READY' on success and 'ERROR'
 * on failure, and `GET /v1/:appId/frontend/deployments` passes
 * `app_deployments.status` through verbatim. So for as long as the poll
 * compared against the lowercase pair, it could not recognise a terminal state
 * at ALL — every real deploy ran the full timeout and returned "did not reach
 * a terminal status", whether the build had gone live or died in 8 seconds.
 *
 * The suite stayed green throughout, because it fed the code the same
 * invented vocabulary the code was checking for. That is the specific way this
 * bug survived: the mock agreed with the bug instead of with production.
 *
 * These cases use the REAL values and would have failed before the fix. Keep
 * the lowercase ones above too — the poll accepts both now, and a deploy path
 * that silently stopped honouring one of them should fail loudly here.
 */
describe('terminal status detection (real platform vocabulary)', () => {
  const okFetch = () => vi.fn(async () => new Response('', { status: 200 }) as any) as any

  async function deployWith(statusRow: Record<string, unknown>) {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'package.json', '{}')
    const originalFetch = globalThis.fetch
    globalThis.fetch = okFetch()
    const mcp = makeMcp({
      create_from_source: () => ({ deployment_id: 'dep_x', upload_url: 'https://s3/put' }),
      start_from_source: () => ({ deployment_id: 'dep_x', status: 'WAITING' }),
      list_deployments: () => ({ deployments: [{ id: 'dep_x', ...statusRow }] }),
    })
    try {
      const d = createDeployer({ cache, mcp, onDeploymentProgress: () => {}, pollIntervalMs: 1, maxWaitMs: 200 })
      return await d.deploy({ convId: CONV, appId: APP, jwt: JWT })
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  it('treats READY as success and returns the url', async () => {
    expect(await deployWith({ status: 'READY', url: 'https://x.butterbase.dev' })).toMatchObject({
      ok: true, deployment_id: 'dep_x', url: 'https://x.butterbase.dev',
    })
  })

  it('treats ERROR as failure rather than waiting out the whole window', async () => {
    expect(await deployWith({ status: 'ERROR', error: 'BUILD_NONZERO_EXIT' })).toMatchObject({
      ok: false, error: 'BUILD_NONZERO_EXIT',
    })
  })

  it('surfaces error_message when the row carries that instead of error', async () => {
    // The deployments route has used both spellings; reporting "build failed"
    // when a real reason was available is what sent the operator looking for a
    // bug in its own source.
    expect(await deployWith({ status: 'ERROR', error_message: 'npm ERR! missing script: build' })).toMatchObject({
      ok: false, error: 'npm ERR! missing script: build',
    })
  })

  it('still reports a genuine timeout when the build never terminates', async () => {
    const r = await deployWith({ status: 'BUILDING' });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).error).toMatch(/did not reach a terminal status/);
    // The old text told the caller to "check list_deployments", which no
    // operator-reachable tool can do; following it cost a turn to a validation
    // error on 2026-08-10.
    expect((r as any).error).not.toMatch(/list_deployments/);
  })
})
