import { describe, expect, it } from 'vitest'
import { WorkingTreeCache } from '../working-tree'

const CONV = 'c1'
const APP = 'a1'

describe('WorkingTreeCache', () => {
  it('returns undefined before any write', () => {
    const c = new WorkingTreeCache()
    expect(c.get(CONV, APP)).toBeUndefined()
  })

  it('write() creates the tree, upserts, and computes sha256', () => {
    const c = new WorkingTreeCache()
    const f1 = c.write(CONV, APP, 'src/App.tsx', 'export default () => null')
    expect(f1.path).toBe('src/App.tsx')
    expect(f1.sha256).toMatch(/^[0-9a-f]{64}$/)
    const f2 = c.write(CONV, APP, 'src/App.tsx', 'export default () => "hi"')
    expect(f2.sha256).not.toBe(f1.sha256)
    expect(c.read(CONV, APP, 'src/App.tsx')).toBe('export default () => "hi"')
  })

  it('write() isolates convs and apps', () => {
    const c = new WorkingTreeCache()
    c.write(CONV, APP, 'a.ts', 'A')
    c.write('c2', APP, 'a.ts', 'B')
    c.write(CONV, 'a2', 'a.ts', 'C')
    expect(c.read(CONV, APP, 'a.ts')).toBe('A')
    expect(c.read('c2', APP, 'a.ts')).toBe('B')
    expect(c.read(CONV, 'a2', 'a.ts')).toBe('C')
  })

  it('delete() removes and returns true; false when absent', () => {
    const c = new WorkingTreeCache()
    c.write(CONV, APP, 'a.ts', 'A')
    expect(c.delete(CONV, APP, 'a.ts')).toBe(true)
    expect(c.delete(CONV, APP, 'a.ts')).toBe(false)
    expect(c.read(CONV, APP, 'a.ts')).toBeUndefined()
  })

  it('list() returns path+size for every file', () => {
    const c = new WorkingTreeCache()
    c.write(CONV, APP, 'a.ts', 'AA')
    c.write(CONV, APP, 'b.ts', 'BBBB')
    const list = c.list(CONV, APP).sort((a, b) => a.path.localeCompare(b.path))
    expect(list).toEqual([
      { path: 'a.ts', size: 2 },
      { path: 'b.ts', size: 4 },
    ])
  })

  it('diff() reports changed and deleted vs baseline', () => {
    const c = new WorkingTreeCache()
    c.write(CONV, APP, 'a.ts', 'A')
    c.write(CONV, APP, 'b.ts', 'B')
    const baseline = c.snapshotBaseline(CONV, APP)
    c.write(CONV, APP, 'a.ts', 'A2') // change
    c.write(CONV, APP, 'c.ts', 'C')  // add
    c.delete(CONV, APP, 'b.ts')       // delete
    const d = c.diff(CONV, APP, baseline)
    const changedPaths = d.changed.map(f => f.path).sort()
    expect(changedPaths).toEqual(['a.ts', 'c.ts'])
    expect(d.deleted).toEqual(['b.ts'])
  })

  it('set() replaces the tree wholesale (used by pull_latest hydration)', () => {
    const c = new WorkingTreeCache()
    c.write(CONV, APP, 'a.ts', 'X')
    const tree = new Map<string, { path: string; content: string; sha256: string }>()
    tree.set('b.ts', { path: 'b.ts', content: 'Y', sha256: 'deadbeef'.repeat(8) })
    c.set(CONV, APP, tree)
    expect(c.read(CONV, APP, 'a.ts')).toBeUndefined()
    expect(c.read(CONV, APP, 'b.ts')).toBe('Y')
  })

  it('evict() clears the tree', () => {
    const c = new WorkingTreeCache()
    c.write(CONV, APP, 'a.ts', 'A')
    c.evict(CONV, APP)
    expect(c.get(CONV, APP)).toBeUndefined()
  })
})
