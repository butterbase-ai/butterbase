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
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 }) as any) as any
    const mcp = makeMcp({
      create_from_source: () => ({ deployment_id: 'dep_2', upload_url: 'https://s3/put' }),
      start_from_source: () => ({ deployment_id: 'dep_2', status: 'queued' }),
      list_deployments: () => ({ deployments: [{ id: 'dep_2', status: 'failed', error: 'build error' }] }),
    })
    const d = createDeployer({ cache, mcp, onDeploymentProgress: () => {}, pollIntervalMs: 1, maxWaitMs: 5000 })
    const r = await d.deploy({ convId: CONV, appId: APP, jwt: JWT })
    expect(r).toMatchObject({ ok: false })
  })
})
