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
