import { describe, expect, it, vi } from 'vitest'
import { WorkingTreeCache } from '../working-tree'
import { createRepoSync } from '../repo-sync'

const CONV = 'c1', APP = 'a1', JWT = 'jwt.example'

function mkMcp(handlers: Record<string, (args: any) => any>) {
  return {
    call: vi.fn(async (name: string, args: any, jwt: string) => {
      if (jwt !== JWT) throw new Error('bad jwt')
      const h = handlers[args.action]
      if (!h) throw new Error(`unhandled action ${args.action}`)
      return h(args)
    }),
  }
}

describe('repo-sync', () => {
  it('pullLatest hydrates the cache from manifest + presigned GETs', async () => {
    const cache = new WorkingTreeCache()
    const mcp = mkMcp({
      pull_latest: () => ({
        snapshot_id: 'snap_1',
        files: [
          { path: 'src/App.tsx', sha256: 'a'.repeat(64), download_url: 'https://s3/a' },
          { path: 'package.json', sha256: 'b'.repeat(64), download_url: 'https://s3/b' },
        ],
      }),
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: any) => {
      const s = String(url)
      if (s === 'https://s3/a') return new Response('APP_CONTENT') as any
      if (s === 'https://s3/b') return new Response('PKG_CONTENT') as any
      throw new Error(`unexpected fetch ${s}`)
    }) as any
    try {
      const sync = createRepoSync({ cache, mcp })
      const r = await sync.pullLatest({ convId: CONV, appId: APP, jwt: JWT })
      expect(r.hydrated).toBe(true)
      expect(cache.read(CONV, APP, 'src/App.tsx')).toBe('APP_CONTENT')
      expect(cache.read(CONV, APP, 'package.json')).toBe('PKG_CONTENT')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('pullLatest returns hydrated=false on empty repo', async () => {
    const cache = new WorkingTreeCache()
    const mcp = mkMcp({ pull_latest: () => ({ snapshot_id: null, files: [] }) })
    const sync = createRepoSync({ cache, mcp })
    const r = await sync.pullLatest({ convId: CONV, appId: APP, jwt: JWT })
    expect(r.hydrated).toBe(false)
    expect(cache.get(CONV, APP)).toBeUndefined()
  })

  it('pullSnapshot hydrates the cache from a specific snapshot manifest + presigned GETs', async () => {
    const cache = new WorkingTreeCache()
    const mcp = mkMcp({
      pull_snapshot: (args) => {
        expect(args).toEqual({ action: 'pull_snapshot', app_id: APP, snapshot_id: 'snap_old' })
        return {
          snapshot_id: 'snap_old',
          files: [
            { path: 'src/App.tsx', sha256: 'a'.repeat(64), download_url: 'https://s3/a' },
          ],
        }
      },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (url: any) => {
      const s = String(url)
      if (s === 'https://s3/a') return new Response('OLD_APP_CONTENT') as any
      throw new Error(`unexpected fetch ${s}`)
    }) as any
    try {
      const sync = createRepoSync({ cache, mcp })
      const r = await sync.pullSnapshot({ convId: CONV, appId: APP, snapshotId: 'snap_old', jwt: JWT })
      expect(r.hydrated).toBe(true)
      expect(mcp.call).toHaveBeenCalledWith('manage_repo', { action: 'pull_snapshot', app_id: APP, snapshot_id: 'snap_old' }, JWT)
      expect(cache.read(CONV, APP, 'src/App.tsx')).toBe('OLD_APP_CONTENT')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('pullSnapshot returns hydrated=false on empty snapshot', async () => {
    const cache = new WorkingTreeCache()
    const mcp = mkMcp({ pull_snapshot: () => ({ snapshot_id: null, files: [] }) })
    const sync = createRepoSync({ cache, mcp })
    const r = await sync.pullSnapshot({ convId: CONV, appId: APP, snapshotId: 'snap_old', jwt: JWT })
    expect(r.hydrated).toBe(false)
    expect(cache.get(CONV, APP)).toBeUndefined()
  })

  it('flush pushes the FULL current tree (manage_repo.push replaces manifest — no inheritance)', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'a.ts', 'A')
    cache.write(CONV, APP, 'b.ts', 'B')
    const baseline = cache.snapshotBaseline(CONV, APP)
    cache.write(CONV, APP, 'a.ts', 'A2') // change
    cache.write(CONV, APP, 'c.ts', 'C')  // add
    let received: any = null
    const mcp = mkMcp({ push: (args) => { received = args; return { snapshot_id: 'snap_2' } } })
    const sync = createRepoSync({ cache, mcp })
    const r = await sync.flush({ convId: CONV, appId: APP, jwt: JWT, baseline })
    expect(r.pushed).toBe(3)
    const paths = received.files.map((f: any) => f.path).sort()
    expect(paths).toEqual(['a.ts', 'b.ts', 'c.ts'])
    const a = received.files.find((f: any) => f.path === 'a.ts')
    expect(Buffer.from(a.content_base64, 'base64').toString('utf8')).toBe('A2')
    // b.ts (unchanged) MUST also be present — anti-regression assertion
    const b = received.files.find((f: any) => f.path === 'b.ts')
    expect(Buffer.from(b.content_base64, 'base64').toString('utf8')).toBe('B')
  })

  it('turn 2 flush preserves files that were untouched this turn', async () => {
    const cache = new WorkingTreeCache()
    // Simulate hydrated state from prior turn's push
    cache.write(CONV, APP, 'src/App.tsx', 'v1')
    cache.write(CONV, APP, 'package.json', '{}')
    cache.write(CONV, APP, 'vite.config.ts', '// vite')
    // Turn 2 begins — baseline snapshot taken now
    const baseline = cache.snapshotBaseline(CONV, APP)
    // Turn 2 edits ONE file
    cache.write(CONV, APP, 'src/App.tsx', 'v2')
    let received: any = null
    const mcp = mkMcp({ push: (args) => { received = args; return { snapshot_id: 'snap_3' } } })
    const sync = createRepoSync({ cache, mcp })
    const r = await sync.flush({ convId: CONV, appId: APP, jwt: JWT, baseline })
    expect(r.pushed).toBe(3)
    const paths = received.files.map((f: any) => f.path).sort()
    expect(paths).toEqual(['package.json', 'src/App.tsx', 'vite.config.ts'])
  })

  it('flush is a no-op when nothing changed', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'a.ts', 'A')
    const baseline = cache.snapshotBaseline(CONV, APP)
    const mcp = mkMcp({ push: () => ({ snapshot_id: 'x' }) })
    const sync = createRepoSync({ cache, mcp })
    const r = await sync.flush({ convId: CONV, appId: APP, jwt: JWT, baseline })
    expect(r.pushed).toBe(0)
    expect(mcp.call).not.toHaveBeenCalled()
  })
})
