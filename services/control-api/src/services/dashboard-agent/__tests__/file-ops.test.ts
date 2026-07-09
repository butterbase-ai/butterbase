import { describe, expect, it, vi } from 'vitest'
import { WorkingTreeCache } from '../working-tree'
import { createFileOps } from '../file-ops'

function setup() {
  const cache = new WorkingTreeCache()
  const events: any[] = []
  const activeEvents: any[] = []
  const hydrate = vi.fn(async () => {})
  const ops = createFileOps({
    cache,
    repoSync: { pullLatest: vi.fn(), flush: vi.fn() } as any,
    apiUrl: 'https://api.example.com',
    onFileChange: (e) => events.push(e),
    onActiveAppChange: (e) => activeEvents.push(e),
    ensureHydrated: hydrate,
  })
  return { cache, ops, events, activeEvents, hydrate }
}

const CTX = { convId: 'c1', jwt: 'jwt' }

describe('file-ops', () => {
  it('write_file writes to cache and emits file_change', async () => {
    const { ops, cache, events } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'src/App.tsx', content: 'X' }, CTX)
    expect(r.ok).toBe(true)
    expect(cache.read(CTX.convId, 'a1', 'src/App.tsx')).toBe('X')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ app_id: 'a1', path: 'src/App.tsx', kind: 'write', content: 'X' })
  })

  it('write_file emits active_app_change on first touch of a new app', async () => {
    const { ops, activeEvents } = setup()
    await ops.execute('write_file', { app_id: 'a1', path: 'x.ts', content: 'A' }, CTX)
    await ops.execute('write_file', { app_id: 'a1', path: 'y.ts', content: 'B' }, CTX) // same app, no repeat event
    await ops.execute('write_file', { app_id: 'a2', path: 'x.ts', content: 'C' }, CTX) // new active app
    expect(activeEvents.map(e => e.appId)).toEqual(['a1', 'a2'])
  })

  it('write_file calls ensureHydrated before mutating', async () => {
    const { ops, hydrate } = setup()
    await ops.execute('write_file', { app_id: 'a1', path: 'x.ts', content: 'A' }, CTX)
    expect(hydrate).toHaveBeenCalledWith({ convId: 'c1', appId: 'a1', jwt: 'jwt' })
  })

  it('write_file rejects package.json', async () => {
    const { ops } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'package.json', content: '{}' }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('package.json is managed')
  })

  it('write_file rejects path traversal', async () => {
    const { ops } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: '../evil.ts', content: 'X' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('write_file rejects >512KB', async () => {
    const { ops } = setup()
    const big = 'x'.repeat(512 * 1024 + 1)
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'big.ts', content: big }, CTX)
    expect(r.ok).toBe(false)
  })

  it('read_file returns cached content', async () => {
    const { ops } = setup()
    await ops.execute('write_file', { app_id: 'a1', path: 'x.ts', content: 'HELLO' }, CTX)
    const r = await ops.execute('read_file', { app_id: 'a1', path: 'x.ts' }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.data as any).content).toBe('HELLO')
  })

  it('read_file returns not-found for missing path', async () => {
    const { ops } = setup()
    const r = await ops.execute('read_file', { app_id: 'a1', path: 'nope.ts' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('list_files returns path+size', async () => {
    const { ops } = setup()
    await ops.execute('write_file', { app_id: 'a1', path: 'a.ts', content: 'AAA' }, CTX)
    await ops.execute('write_file', { app_id: 'a1', path: 'b.ts', content: 'B' }, CTX)
    const r = await ops.execute('list_files', { app_id: 'a1' }, CTX)
    expect(r.ok).toBe(true)
    if (r.ok) {
      const files = ((r.data as any).files as any[]).sort((x, y) => x.path.localeCompare(y.path))
      expect(files).toEqual([{ path: 'a.ts', size: 3 }, { path: 'b.ts', size: 1 }])
    }
  })

  it('delete_file removes and emits kind=delete', async () => {
    const { ops, cache, events } = setup()
    await ops.execute('write_file', { app_id: 'a1', path: 'a.ts', content: 'A' }, CTX)
    events.length = 0
    const r = await ops.execute('delete_file', { app_id: 'a1', path: 'a.ts' }, CTX)
    expect(r.ok).toBe(true)
    expect(cache.read(CTX.convId, 'a1', 'a.ts')).toBeUndefined()
    expect(events).toEqual([{ app_id: 'a1', path: 'a.ts', kind: 'delete' }])
  })

  it('write_file allows functions/<name>/index.ts', async () => {
    const { ops, cache } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'functions/hello/index.ts', content: 'export default {}' }, CTX)
    expect(r.ok).toBe(true)
    expect(cache.read(CTX.convId, 'a1', 'functions/hello/index.ts')).toBe('export default {}')
  })

  it('write_file allows functions/<name>/package.json', async () => {
    const { ops, cache } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'functions/hello/package.json', content: '{"name":"hello"}' }, CTX)
    expect(r.ok).toBe(true)
    expect(cache.read(CTX.convId, 'a1', 'functions/hello/package.json')).toBe('{"name":"hello"}')
  })

  it('write_file allows functions/<name>/nested/dir/util.ts', async () => {
    const { ops, cache } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'functions/hello/nested/dir/util.ts', content: 'export const x = 1' }, CTX)
    expect(r.ok).toBe(true)
    expect(cache.read(CTX.convId, 'a1', 'functions/hello/nested/dir/util.ts')).toBe('export const x = 1')
  })

  it('write_file rejects functions/../malicious.ts (path traversal)', async () => {
    const { ops } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'functions/../malicious.ts', content: 'X' }, CTX)
    expect(r.ok).toBe(false)
  })

  it('write_file still rejects root package.json', async () => {
    const { ops } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'package.json', content: '{}' }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('package.json is managed')
  })

  it('write_file still rejects root package-lock.json', async () => {
    const { ops } = setup()
    const r = await ops.execute('write_file', { app_id: 'a1', path: 'package-lock.json', content: '{}' }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('package.json is managed')
  })

  it('delete_file allows functions/<name>/file.ts', async () => {
    const { ops, cache } = setup()
    await ops.execute('write_file', { app_id: 'a1', path: 'functions/hello/file.ts', content: 'X' }, CTX)
    const r = await ops.execute('delete_file', { app_id: 'a1', path: 'functions/hello/file.ts' }, CTX)
    expect(r.ok).toBe(true)
    expect(cache.read(CTX.convId, 'a1', 'functions/hello/file.ts')).toBeUndefined()
  })

  it('delete_file still rejects root package.json', async () => {
    const { ops } = setup()
    const r = await ops.execute('delete_file', { app_id: 'a1', path: 'package.json' }, CTX)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('package.json is managed')
  })
})
