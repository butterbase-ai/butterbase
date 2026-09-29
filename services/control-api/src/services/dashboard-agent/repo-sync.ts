import type { WorkingFile, WorkingTree, WorkingTreeCache } from './working-tree.js'

type Mcp = { call(name: string, args: unknown, jwt: string): Promise<any> }

export type RepoSync = {
  pullLatest(input: { convId: string; appId: string; jwt: string }): Promise<{ hydrated: boolean }>
  pullSnapshot(input: { convId: string; appId: string; snapshotId: string; jwt: string }): Promise<{ hydrated: boolean }>
  flush(input: {
    convId: string
    appId: string
    jwt: string
    baseline: Map<string, string>
  }): Promise<{ pushed: number; deleted: number; newSnapshotId: string | null }>
  /**
   * Push the ENTIRE current cache contents for (convId, appId) as a brand new
   * snapshot, unconditionally (no baseline/diff short-circuit — unlike flush,
   * this always pushes even if nothing "changed" relative to some baseline).
   * Used by the rewind endpoint: after pullSnapshot overwrites the cache with
   * an older snapshot's contents, we push that state back out so it becomes
   * the new latest (append-only history — we never mutate/delete snapshots).
   */
  pushCurrentTree(input: { convId: string; appId: string; jwt: string }): Promise<{ snapshotId: string | null; filesPushed: number }>
}

/**
 * One manifest entry as manage_repo pull_latest / pull_snapshot return it
 * (services/mcp-server/src/tools/manage-repo.ts): the presigned URL is
 * `downloadUrl`, and is null when the blob batch returned no URL for a sha.
 */
type RepoFile = { path: string; sha256: string; size?: number; downloadUrl: string | null }

/**
 * The repo route's messages for "this app has no latest snapshot"
 * (routes/repo.ts GET /v1/:app_id/repo/snapshots/latest). manage_repo passes
 * the route's JSON error body through as its error text.
 */
const NO_SNAPSHOT_RE = /No snapshots have been pushed for this app|latest pointer references missing manifest/

function downloadUrlOf(f: RepoFile): string {
  if (!f.downloadUrl) throw new Error(`repo pull: no download url returned for ${f.path}`)
  return f.downloadUrl
}

export function createRepoSync(deps: { cache: WorkingTreeCache; mcp: Mcp }): RepoSync {
  const { cache, mcp } = deps
  return {
    async pullLatest({ convId, appId, jwt }) {
      let res: any
      try {
        res = await mcp.call('manage_repo', { action: 'pull_latest', app_id: appId }, jwt)
      } catch (err) {
        // A new app has no snapshot yet: the repo route 404s and manage_repo
        // surfaces that as an isError result, which the MCP transport turns
        // into a throw. That is "empty repo", not a failure — report it as
        // unhydrated so ensureHydrated scaffolds from a template (mirrors
        // repo-http.ts's allow404). Only the no-snapshot messages count: an
        // "App not found" 404 (no access) must still throw, or the turn would
        // push a template into an app it cannot see.
        if (err instanceof Error && NO_SNAPSHOT_RE.test(err.message)) return { hydrated: false }
        throw err
      }
      const files: RepoFile[] = res?.files ?? []
      if (!res?.snapshot_id || files.length === 0) return { hydrated: false }
      const tree: WorkingTree = new Map()
      await Promise.all(files.map(async (f) => {
        const resp = await fetch(downloadUrlOf(f))
        const content = await resp.text()
        const wf: WorkingFile = { path: f.path, content, sha256: f.sha256 }
        tree.set(f.path, wf)
      }))
      cache.set(convId, appId, tree)
      return { hydrated: true }
    },

    async pullSnapshot({ convId, appId, snapshotId, jwt }) {
      const res = await mcp.call('manage_repo', { action: 'pull_snapshot', app_id: appId, snapshot_id: snapshotId }, jwt)
      const files: RepoFile[] = res?.files ?? []
      if (!res?.snapshot_id || files.length === 0) return { hydrated: false }
      const tree: WorkingTree = new Map()
      await Promise.all(files.map(async (f) => {
        const resp = await fetch(downloadUrlOf(f))
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
        return { pushed: 0, deleted: 0, newSnapshotId: null }
      }
      const tree = cache.get(convId, appId)
      if (!tree || tree.size === 0) {
        return { pushed: 0, deleted: deleted.length, newSnapshotId: null }
      }
      // manage_repo.push replaces the entire snapshot manifest — no inheritance
      // from prior snapshots. We must always send the full current tree so that
      // files untouched this turn are not silently dropped on the next pull.
      const files = Array.from(tree.values()).map(f => ({
        path: f.path,
        content_base64: Buffer.from(f.content, 'utf8').toString('base64'),
      }))
      const res = await mcp.call('manage_repo', { action: 'push', app_id: appId, files }, jwt)
      return { pushed: files.length, deleted: deleted.length, newSnapshotId: res?.snapshot_id ?? null }
    },

    async pushCurrentTree({ convId, appId, jwt }) {
      const tree = cache.get(convId, appId)
      const files = tree
        ? Array.from(tree.values()).map(f => ({
            path: f.path,
            content_base64: Buffer.from(f.content, 'utf8').toString('base64'),
          }))
        : []
      const res = await mcp.call('manage_repo', { action: 'push', app_id: appId, files }, jwt)
      return { snapshotId: res?.snapshot_id ?? null, filesPushed: files.length }
    },
  }
}
