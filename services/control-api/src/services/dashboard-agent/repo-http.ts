import type { WorkingFile, WorkingTree, WorkingTreeCache } from './working-tree.js'
import type { RepoSync } from './repo-sync.js'

/**
 * `RepoSync` over the repo HTTP routes, for AUTONOMOUS OPERATOR turns.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * The operator could not read or persist app source at all. `repo-sync.ts`
 * reaches the repo through `manage_repo` over MCP; on an operator turn that
 * goes through `turnMcp` (loop.ts), which admits only an 'allow' verdict, and
 * `manage_repo` sits at 'approval' in operator-policy.ts. So hydration was
 * refused on EVERY operator turn at EVERY yolo setting: the operator started
 * each turn with an empty working tree and lost everything at turn end.
 *
 * WHY HTTP RATHER THAN CALLING repo-storage.ts IN-PROCESS
 * -------------------------------------------------------
 * The loop runs in the same process as `repo-storage.ts`, so in-process calls
 * were the obvious shortcut. They were tried and rejected: `repo-storage.ts`
 * takes `appId` as a plain parameter and authorizes nothing, so that route
 * requires writing a THIRD repo authorizer alongside `authorizeRepoRead` /
 * `authorizeRepoWrite`. A reimplemented tenancy check, on a path that both
 * reads and writes, running unattended on an org service key, is exactly where
 * a cross-org leak appears — and it would have to be audited separately
 * forever. Going through the routes means `requireUserId` +
 * `authorizeRepoWrite` (routes/repo.ts:57,136) decide access, and they are the
 * same lines the human dashboard already depends on.
 *
 * The MCP-only ~1 MB push cap is not inherited: it lives in the MCP tool
 * (mcp-server manage-repo.ts), whose own error text points at
 * `butterbase repo push` for larger snapshots — the CLI reaches these same
 * routes without it. The REAL limits (100 MB/snapshot, 10 MB/file, the per-app
 * `storage_config.total_size_limit` quota) are enforced by repo-manifest
 * validation and the prepare handler, and this client inherits all of them by
 * construction rather than reimplementing any.
 *
 * AUTHENTICATION is the `jwt` already threaded through every `RepoSync`
 * method. On an operator turn that value is the org's `bb_sk_*` service key
 * (operator-credential.ts → operator-turn.ts → `runAgentTurn({ jwt })`), which
 * plugins/auth.ts resolves through `ApiKeyService.validateApiKey` into
 * `{ userId: key.user_id, organizationId: key.organization_id }` — satisfying
 * `requireUserId` and putting `authorizeRepoWrite` on branch 1 of
 * `AppResolver.resolveApp` ("app in caller's active org").
 *
 * DELIBERATELY ABSENT: any call to `DELETE /v1/:app_id/repo` (wipe). The same
 * credential authorizes it — wipe uses the identical `authorizeRepoWrite` — so
 * this omission is a scope decision, not a boundary. Wipe is irreversible;
 * nothing here should acquire the ability to reach it without that being a
 * deliberate, separately reviewed change.
 *
 * The human/dashboard assistant keeps using `repo-sync.ts` over MCP unchanged.
 */

/** Manifest entry shape shared by the prepare/commit bodies and the routes. */
type ManifestFile = { path: string; sha256: string; size: number }
type ManifestBody = { files: ManifestFile[]; message?: string }

/**
 * The blobs/batch endpoint rejects more than 1000 shas per call, so a large
 * repo's presign request is chunked. Kept as a named constant rather than a
 * literal at the call site because it is a SERVER limit — if the route's cap
 * moves, this is the line that has to move with it.
 */
const BLOB_BATCH_LIMIT = 1000

/**
 * Where control-api's own HTTP routes live, as seen from this process.
 *
 * `CONTROL_API_URL` first because that is the existing name for exactly this
 * (mcp-server's api-client.ts reads it), then `PUBLIC_API_URL`, which loop.ts
 * already reads for the template placeholder. On Fly this deliberately
 * resolves to the public anycast host rather than a loopback: cross-region app
 * requests must pass through the Fly proxy so `plugins/fly-replay.ts` can
 * redirect them to the app's home region. A loopback would bypass the proxy
 * and get the empty 204 fly-replay response — the same trap documented in
 * mcp-server's api-client.
 */
function defaultBaseUrl(): string {
  return process.env.CONTROL_API_URL ?? process.env.PUBLIC_API_URL ?? 'http://localhost:4000'
}

export type HttpRepoSyncDeps = {
  cache: WorkingTreeCache
  baseUrl?: string
  /** Injectable for tests. Production uses global `fetch`. */
  fetchImpl?: typeof fetch
}

export function createHttpRepoSync(deps: HttpRepoSyncDeps): RepoSync {
  const { cache } = deps
  const baseUrl = (deps.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '')
  const doFetch = deps.fetchImpl ?? fetch

  /**
   * Every control-api call funnels through here so the credential header is
   * attached in exactly one place. Presigned S3 URLs are fetched with the bare
   * `doFetch` instead — a presigned URL is already authorized, and attaching an
   * org service key to an arbitrary storage host would leak it off-platform.
   */
  async function api<T>(
    method: 'GET' | 'POST',
    path: string,
    jwt: string,
    body?: unknown,
  ): Promise<{ status: number; body: T | null }> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    // Read as text first: error bodies are not always JSON, and a 204/empty
    // body would make res.json() throw with a message that says nothing about
    // the status the caller actually needs to see.
    const text = await res.text()
    let parsed: T | null = null
    if (text) { try { parsed = JSON.parse(text) as T } catch { parsed = null } }
    if (!res.ok) {
      throw new Error(`repo ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    }
    return { status: res.status, body: parsed }
  }

  /**
   * Fetch a manifest and populate the cache from it.
   *
   * `allow404` distinguishes the two callers. On `pullLatest` a 404 means "this
   * app has no snapshots yet" — the normal state of a new app — and must be
   * reported as `hydrated: false` so `ensureHydrated` scaffolds from a
   * template. Every OTHER non-2xx, 403 above all, must throw: laundering "you
   * may not see this app" into "this app is empty" would send the turn down the
   * scaffold path and then try to push a template into someone else's app.
   */
  async function hydrateFrom(
    convId: string,
    appId: string,
    jwt: string,
    path: string,
    allow404: boolean,
  ): Promise<{ hydrated: boolean }> {
    let snap: { snapshot_id?: string; manifest?: { files?: ManifestFile[] } } | null
    try {
      snap = (await api<{ snapshot_id: string; manifest: { files: ManifestFile[] } }>('GET', path, jwt)).body
    } catch (err) {
      if (allow404 && err instanceof Error && / failed \(404\)/.test(err.message)) {
        return { hydrated: false }
      }
      throw err
    }

    const files = snap?.manifest?.files ?? []
    if (!snap?.snapshot_id || files.length === 0) return { hydrated: false }

    // Content-addressed: distinct paths can share one blob, so presign per
    // distinct sha, not per file.
    const distinct = [...new Set(files.map(f => f.sha256))]
    const urlBySha = new Map<string, string>()
    for (let i = 0; i < distinct.length; i += BLOB_BATCH_LIMIT) {
      const chunk = distinct.slice(i, i + BLOB_BATCH_LIMIT)
      const res = await api<{ blobs: { sha256: string; downloadUrl: string }[] }>(
        'POST', `/v1/${appId}/repo/blobs/batch`, jwt, { shas: chunk },
      )
      for (const b of res.body?.blobs ?? []) urlBySha.set(b.sha256, b.downloadUrl)
    }

    // One fetch per distinct blob, then fan the content out to every path that
    // references it — a repo with many identical files (empty `index.ts`,
    // repeated configs) otherwise downloads the same bytes repeatedly.
    const contentBySha = new Map<string, string>()
    await Promise.all(distinct.map(async sha => {
      const url = urlBySha.get(sha)
      if (!url) throw new Error(`repo pull: no download url returned for blob ${sha}`)
      const resp = await doFetch(url)
      if (!resp.ok) throw new Error(`repo pull: blob ${sha} download failed (${resp.status})`)
      contentBySha.set(sha, await resp.text())
    }))

    const tree: WorkingTree = new Map()
    for (const f of files) {
      const content = contentBySha.get(f.sha256) ?? ''
      const wf: WorkingFile = { path: f.path, content, sha256: f.sha256 }
      tree.set(f.path, wf)
    }
    cache.set(convId, appId, tree)
    return { hydrated: true }
  }

  /**
   * prepare → PUT the blobs the server says it is missing → commit.
   *
   * The manifest object handed to `prepare` is resent VERBATIM to `commit`.
   * The snapshot id is a hash of the canonicalised manifest, so rebuilding the
   * body a second time would risk committing a different snapshot than the one
   * that was validated and quota-checked.
   */
  async function pushTree(
    appId: string,
    jwt: string,
    tree: WorkingTree,
  ): Promise<{ snapshotId: string | null; filesPushed: number }> {
    const contentBySha = new Map<string, string>()
    const files: ManifestFile[] = []
    for (const f of tree.values()) {
      // `Buffer.byteLength`, never `content.length`: the server HEADs each blob
      // and rejects the commit when the stored object's size disagrees with the
      // manifest, and what lands in S3 is UTF-8 bytes, not UTF-16 code units.
      files.push({ path: f.path, sha256: f.sha256, size: Buffer.byteLength(f.content, 'utf8') })
      contentBySha.set(f.sha256, f.content)
    }
    const manifest: ManifestBody = { files }

    const prep = await api<{ snapshot_id: string; missing_blobs: { sha256: string; uploadUrl: string }[] }>(
      'POST', `/v1/${appId}/repo/snapshots/prepare`, jwt, manifest,
    )
    for (const m of prep.body?.missing_blobs ?? []) {
      const content = contentBySha.get(m.sha256)
      if (content === undefined) {
        throw new Error(`repo push: server asked for blob ${m.sha256} which is not in our manifest`)
      }
      const put = await doFetch(m.uploadUrl, {
        method: 'PUT',
        body: Buffer.from(content, 'utf8') as unknown as BodyInit,
        headers: { 'content-type': 'application/octet-stream' },
      })
      if (!put.ok) {
        throw new Error(`repo push: presigned PUT for ${m.sha256} failed (${put.status})`)
      }
    }

    const commit = await api<{ snapshot_id: string }>(
      'POST', `/v1/${appId}/repo/snapshots/commit`, jwt, { manifest },
    )
    return { snapshotId: commit.body?.snapshot_id ?? null, filesPushed: files.length }
  }

  return {
    async pullLatest({ convId, appId, jwt }) {
      return hydrateFrom(convId, appId, jwt, `/v1/${appId}/repo/snapshots/latest`, true)
    },

    async pullSnapshot({ convId, appId, snapshotId, jwt }) {
      // A specific snapshot id that 404s is a real error — unlike `latest`,
      // nobody asks for a snapshot id they did not first read from the server.
      return hydrateFrom(
        convId, appId, jwt,
        `/v1/${appId}/repo/snapshots/${encodeURIComponent(snapshotId)}`,
        false,
      )
    },

    async flush({ convId, appId, jwt, baseline }) {
      const { changed, deleted } = cache.diff(convId, appId, baseline)
      if (changed.length === 0 && deleted.length === 0) {
        return { pushed: 0, deleted: 0, newSnapshotId: null }
      }
      const tree = cache.get(convId, appId)
      if (!tree || tree.size === 0) {
        // Committing a zero-file manifest would delete the whole repo. That is
        // never something an implicit end-of-turn flush should do; the deletes
        // are reported and the push is skipped. Same choice repo-sync.ts makes.
        return { pushed: 0, deleted: deleted.length, newSnapshotId: null }
      }
      // The FULL tree, not the diff: a snapshot manifest replaces its
      // predecessor rather than inheriting from it, so files untouched this
      // turn would silently vanish on the next pull if they were omitted.
      const res = await pushTree(appId, jwt, tree)
      return { pushed: res.filesPushed, deleted: deleted.length, newSnapshotId: res.snapshotId }
    },

    async pushCurrentTree({ convId, appId, jwt }) {
      const tree = cache.get(convId, appId) ?? new Map<string, WorkingFile>()
      return pushTree(appId, jwt, tree)
    },
  }
}
