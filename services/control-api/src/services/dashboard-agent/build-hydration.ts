import { createHash } from 'node:crypto'
import type { WorkingTreeCache } from './working-tree.js'

/**
 * Makes the operator's CURRENT working tree fetchable by a credential-less
 * sandbox, so it can be compiled before it is deployed.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * Phases 1-2 gave the operator repo READ and PERSIST (repo-http.ts). Nothing
 * type-checks or compiles what it writes: for functions there is no build at
 * all, and for frontends the only compile happens inside a deploy — so the
 * agent learns it was wrong by SHIPPING. The sandbox can run a build, but it
 * needs the source on disk first.
 *
 * ---------------------------------------------------------------------------
 * WHY PRESIGNED URLS, AND NOT THE CREDENTIAL
 * ---------------------------------------------------------------------------
 * The obvious shape — hand the sandbox the org's `bb_sk_*` and let it pull the
 * repo itself — is FORBIDDEN, and not as a matter of taste:
 *
 *   - that key can WIPE the app repo. `DELETE /v1/:app_id/repo` shares
 *     `authorizeRepoWrite` with commit (routes/repo.ts), so holding the key is
 *     holding the destroy button for the customer's source.
 *   - the sandbox executes MODEL-AUTHORED code with unrestricted egress. The
 *     stock template has ordinary outbound internet and nothing restricts it —
 *     operator-policy.ts says so explicitly rather than pretending otherwise.
 *
 * So the credential stays HERE, on the control-api side where it already
 * lives, and what crosses into the guest is a list of presigned, blob-scoped,
 * time-limited (1h, set by the batch route) GET urls. Blast radius of a leaked
 * one: a single already-known blob of a single app, read-only, for an hour.
 *
 * The `credential` block in __tests__/build-hydration.test.ts is the executable
 * form of that rule, asserted against the RETURNED VALUE — the exact object
 * that crosses the boundary — rather than against the arguments somebody
 * remembered to check.
 *
 * ---------------------------------------------------------------------------
 * WHY prepare-WITHOUT-commit
 * ---------------------------------------------------------------------------
 * The blobs the model wrote THIS TURN are not in storage yet, so presigning the
 * last snapshot's blobs would build stale source — the exact opposite of the
 * point. `prepare` is what uploads them: it returns an upload url for every
 * blob the server is missing, and once those are PUT the batch route will
 * presign them (it filters on `exists`, not on snapshot membership — see
 * routes/repo.ts:390-397).
 *
 * `commit` is deliberately NOT called. A build is not a save. No snapshot is
 * created, no `latest` pointer moves, and nothing any reader of this app sees
 * changes because the operator asked to compile. The blobs that land are
 * content-addressed and are the same bytes the end-of-turn flush would have
 * written anyway — so the only cost brought forward is storage quota, and only
 * for content the turn already intended to keep.
 *
 * ---------------------------------------------------------------------------
 * WHY HTTP RATHER THAN repo-storage.ts IN-PROCESS
 * ---------------------------------------------------------------------------
 * Identical to repo-http.ts's argument, and it has not weakened: `repo-storage.ts`
 * takes `appId` as a plain parameter and authorizes NOTHING. Calling
 * `presignBlobGet` directly would mean the app id the MODEL supplied decides
 * which org's blobs get a public url — a third hand-written tenancy check, on
 * the path that mints credentials-in-a-url, running unattended. Going through
 * the routes means `requireUserId` + `authorizeRepoWrite` (routes/repo.ts:57)
 * decide, exactly as they do for the human dashboard.
 *
 * WHY NOT JUST EXTEND repo-http.ts. Its `RepoSync` contract is pull/flush/push
 * — "move the tree between here and the server" — and this is a third thing:
 * "make the tree readable by a party that is not us". Bolting a
 * presign-for-a-third-party method onto the object whose other three methods
 * are the operator's ONLY repo persistence path would put the credential
 * boundary and the persistence path in one place, where a future edit to
 * either can quietly move the other.
 */

type ManifestFile = { path: string; sha256: string; size: number }

/** Matches the blobs/batch route's server-side cap (routes/repo.ts:368). */
const BLOB_BATCH_LIMIT = 1000

/**
 * Lockfile names, in the order deploy.ts:44-48 checks them. Kept in the same
 * order deliberately: if two lockfiles somehow coexist, the sandbox and the
 * build-runner must pick the same one or their caches key differently and the
 * build stops predicting the deploy.
 */
const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const

/**
 * Same default-resolution order as repo-http.ts's, and for the same reason —
 * on Fly this must be the public anycast host so `plugins/fly-replay.ts` can
 * redirect a cross-region app request. A loopback bypasses the proxy and gets
 * the empty 204 fly-replay response.
 */
function defaultBaseUrl(): string {
  return process.env.CONTROL_API_URL ?? process.env.PUBLIC_API_URL ?? 'http://localhost:4000'
}

/**
 * One file of the tree as the guest will see it.
 *
 * `{ path, url }` and nothing else, ever. The shape is asserted by a test
 * precisely so that adding a field is a decision somebody has to defend rather
 * than something that happens on the way to fixing something else.
 */
export type BuildHydrationFile = { path: string; url: string }

export type BuildHydration = {
  files: BuildHydrationFile[]
  /**
   * sha256 of the lockfile, or of package.json when there is none. Keys the
   * sandbox's node_modules reuse; hex so it is safe to interpolate into the
   * guest-side shell check.
   */
  installKey: string
  fileCount: number
  totalBytes: number
}

export type BuildHydratorDeps = {
  cache: WorkingTreeCache
  baseUrl?: string
  /** Injectable for tests. Production uses global `fetch`. */
  fetchImpl?: typeof fetch
}

export function createBuildHydrator(deps: BuildHydratorDeps) {
  const { cache } = deps
  const baseUrl = (deps.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '')
  const doFetch = deps.fetchImpl ?? fetch

  /**
   * Every control-api call funnels through here so the credential header is
   * attached in exactly ONE place. Presigned storage urls are fetched with the
   * bare `doFetch` below — a presigned url is already authorized, and putting
   * an org service key on an arbitrary storage host leaks it off-platform.
   */
  async function api<T>(path: string, jwt: string, body: unknown): Promise<T | null> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      // Status in the message, not swallowed. A 403 laundered into "this app is
      // empty" would send the build down a path that compiles a scaffold in
      // someone else's name — the same trap repo-http.ts's `allow404` note
      // describes.
      throw new Error(`build hydrate POST ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    }
    try { return text ? (JSON.parse(text) as T) : null } catch { return null }
  }

  /**
   * The dependency-cache key.
   *
   * Reimplemented rather than imported from deploy.ts because that module is
   * the from-source DEPLOY path and is deliberately not being touched by this
   * phase. deploy.ts:40-53 is the source of truth; if it moves, this moves with
   * it, and `__tests__/build-hydration.test.ts` records the agreement. The
   * package.json fallback is not an edge case — dashboard-agent-template ships
   * no lockfile at all, so it is the COMMON path, which is also why the
   * sandbox runs `npm install` and never `npm ci`.
   */
  function installKeyFor(tree: Map<string, { path: string; content: string }>): string {
    let source = ''
    for (const name of LOCKFILE_NAMES) {
      const f = tree.get(name)
      if (f) { source = f.content; break }
    }
    if (!source) source = tree.get('package.json')?.content ?? ''
    return createHash('sha256').update(source, 'utf8').digest('hex')
  }

  return {
    async hydrate(input: { convId: string; appId: string; jwt: string }): Promise<BuildHydration> {
      const { convId, appId, jwt } = input
      const tree = cache.get(convId, appId)
      if (!tree || tree.size === 0) {
        // Refused rather than "built" as an empty tree. An empty build reports
        // success, which would tell the model its code compiles when nothing
        // was compiled at all — the single most misleading result this tool
        // could return.
        throw new Error('build: no files in the workspace for this app — nothing to build')
      }

      const files: ManifestFile[] = []
      const contentBySha = new Map<string, string>()
      let totalBytes = 0
      for (const f of tree.values()) {
        // `Buffer.byteLength`, never `content.length`: the prepare handler
        // validates the manifest against what actually lands in S3, which is
        // UTF-8 bytes, not UTF-16 code units. Same rule as repo-http.ts:209.
        const size = Buffer.byteLength(f.content, 'utf8')
        totalBytes += size
        files.push({ path: f.path, sha256: f.sha256, size })
        contentBySha.set(f.sha256, f.content)
      }

      // prepare: tells us which blobs storage does not have yet, and hands back
      // an upload url for each. Also runs manifest validation and the per-app
      // storage quota check, both of which this path INHERITS rather than
      // reimplements.
      const prep = await api<{ snapshot_id: string; missing_blobs: { sha256: string; uploadUrl: string }[] }>(
        `/v1/${appId}/repo/snapshots/prepare`, jwt, { files },
      )

      for (const m of prep?.missing_blobs ?? []) {
        const content = contentBySha.get(m.sha256)
        if (content === undefined) {
          throw new Error(`build hydrate: server asked for blob ${m.sha256} which is not in our manifest`)
        }
        const put = await doFetch(m.uploadUrl, {
          method: 'PUT',
          body: Buffer.from(content, 'utf8') as unknown as BodyInit,
          headers: { 'content-type': 'application/octet-stream' },
        })
        if (!put.ok) throw new Error(`build hydrate: presigned PUT for ${m.sha256} failed (${put.status})`)
      }

      // Content-addressed: distinct paths can share one blob, so presign per
      // distinct sha and fan the url back out to every path that references it.
      const distinct = [...new Set(files.map((f) => f.sha256))]
      const urlBySha = new Map<string, string>()
      for (let i = 0; i < distinct.length; i += BLOB_BATCH_LIMIT) {
        const chunk = distinct.slice(i, i + BLOB_BATCH_LIMIT)
        const res = await api<{ blobs: { sha256: string; downloadUrl: string }[] }>(
          `/v1/${appId}/repo/blobs/batch`, jwt, { shas: chunk },
        )
        for (const b of res?.blobs ?? []) urlBySha.set(b.sha256, b.downloadUrl)
      }

      const out: BuildHydrationFile[] = files.map((f) => {
        const url = urlBySha.get(f.sha256)
        if (!url) {
          // Means the PUT above did not land, or the route filtered the blob
          // out as absent. Building a tree with a hole in it produces "cannot
          // find module" errors about files the model DID write, which is the
          // worst possible thing to hand back as a compiler complaint.
          throw new Error(`build hydrate: no download url returned for blob ${f.sha256} (${f.path})`)
        }
        return { path: f.path, url }
      })

      return { files: out, installKey: installKeyFor(tree), fileCount: out.length, totalBytes }
    },
  }
}
