import { createHash } from 'node:crypto'

export type WorkingFile = { path: string; content: string; sha256: string }
export type WorkingTree = Map<string, WorkingFile>

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const key = (convId: string, appId: string) => `${convId}:${appId}` as const

export class WorkingTreeCache {
  private store = new Map<string, WorkingTree>()

  get(convId: string, appId: string): WorkingTree | undefined {
    return this.store.get(key(convId, appId))
  }

  set(convId: string, appId: string, tree: WorkingTree): void {
    this.store.set(key(convId, appId), tree)
  }

  private ensure(convId: string, appId: string): WorkingTree {
    const k = key(convId, appId)
    let t = this.store.get(k)
    if (!t) {
      t = new Map()
      this.store.set(k, t)
    }
    return t
  }

  write(convId: string, appId: string, path: string, content: string): WorkingFile {
    const t = this.ensure(convId, appId)
    const file: WorkingFile = { path, content, sha256: sha(content) }
    t.set(path, file)
    return file
  }

  delete(convId: string, appId: string, path: string): boolean {
    const t = this.store.get(key(convId, appId))
    if (!t) return false
    return t.delete(path)
  }

  read(convId: string, appId: string, path: string): string | undefined {
    return this.store.get(key(convId, appId))?.get(path)?.content
  }

  list(convId: string, appId: string): { path: string; size: number }[] {
    const t = this.store.get(key(convId, appId))
    if (!t) return []
    return Array.from(t.values()).map(f => ({ path: f.path, size: Buffer.byteLength(f.content, 'utf8') }))
  }

  snapshotBaseline(convId: string, appId: string): Map<string, string> {
    const out = new Map<string, string>()
    const t = this.store.get(key(convId, appId))
    if (!t) return out
    for (const f of t.values()) out.set(f.path, f.sha256)
    return out
  }

  diff(convId: string, appId: string, baseline: Map<string, string>): { changed: WorkingFile[]; deleted: string[] } {
    const t = this.store.get(key(convId, appId))
    const changed: WorkingFile[] = []
    const deleted: string[] = []
    if (!t) {
      for (const p of baseline.keys()) deleted.push(p)
      return { changed, deleted }
    }
    for (const f of t.values()) {
      if (baseline.get(f.path) !== f.sha256) changed.push(f)
    }
    for (const p of baseline.keys()) {
      if (!t.has(p)) deleted.push(p)
    }
    return { changed, deleted }
  }

  evict(convId: string, appId: string): void {
    this.store.delete(key(convId, appId))
  }
}
