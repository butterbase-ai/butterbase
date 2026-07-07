import type { WorkingFile, WorkingTree, WorkingTreeCache } from './working-tree.js'

type Mcp = { call(name: string, args: unknown, jwt: string): Promise<any> }

export type RepoSync = {
  pullLatest(input: { convId: string; appId: string; jwt: string }): Promise<{ hydrated: boolean }>
  flush(input: {
    convId: string
    appId: string
    jwt: string
    baseline: Map<string, string>
  }): Promise<{ pushed: number; deleted: number }>
}

export function createRepoSync(deps: { cache: WorkingTreeCache; mcp: Mcp }): RepoSync {
  const { cache, mcp } = deps
  return {
    async pullLatest({ convId, appId, jwt }) {
      const res = await mcp.call('manage_repo', { action: 'pull_latest', app_id: appId }, jwt)
      const files: Array<{ path: string; sha256: string; download_url: string }> = res?.files ?? []
      if (!res?.snapshot_id || files.length === 0) return { hydrated: false }
      const tree: WorkingTree = new Map()
      await Promise.all(files.map(async (f) => {
        const resp = await fetch(f.download_url)
        const content = await resp.text()
        const wf: WorkingFile = { path: f.path, content, sha256: f.sha256 }
        tree.set(f.path, wf)
      }))
      cache.set(convId, appId, tree)
      return { hydrated: true }
    },

    async flush({ convId, appId, jwt, baseline }) {
      const { changed, deleted } = cache.diff(convId, appId, baseline)
      // Fast-path: no changes and no deletes → no push
      if (changed.length === 0 && deleted.length === 0) {
        return { pushed: 0, deleted: 0 }
      }
      const tree = cache.get(convId, appId)
      if (!tree || tree.size === 0) {
        return { pushed: 0, deleted: deleted.length }
      }
      // manage_repo.push replaces the entire snapshot manifest — no inheritance
      // from prior snapshots. We must always send the full current tree so that
      // files untouched this turn are not silently dropped on the next pull.
      const files = Array.from(tree.values()).map(f => ({
        path: f.path,
        content_base64: Buffer.from(f.content, 'utf8').toString('base64'),
      }))
      await mcp.call('manage_repo', { action: 'push', app_id: appId, files }, jwt)
      return { pushed: files.length, deleted: deleted.length }
    },
  }
}
