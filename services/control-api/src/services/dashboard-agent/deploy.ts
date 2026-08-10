import JSZip from 'jszip'
import { installKeyFor } from './install-key.js'
import type { WorkingTreeCache } from './working-tree.js'

export type DeploymentProgressEvent = {
  deployment_id: string
  /**
   * Whatever `app_deployments.status` holds, passed through verbatim — in
   * practice WAITING / BUILDING / READY / ERROR.
   *
   * Deliberately widened to `string` from the old
   * `'queued'|'building'|'live'|'failed'` union, which described a vocabulary
   * nothing in this system produces. That union was not merely unused: it made
   * the wrong values look SANCTIONED, and the poll below was written to match
   * it. A narrow type that disagrees with its producer is worse than no type,
   * because it moves the bug from "obviously untyped" to "apparently checked".
   */
  status: string
  url?: string
  log_tail?: string
  error?: string
}

type Mcp = { call(name: string, args: unknown, jwt: string): Promise<any> }

export type DeployDeps = {
  cache: WorkingTreeCache
  mcp: Mcp
  onDeploymentProgress(evt: DeploymentProgressEvent): void
  pollIntervalMs?: number
  maxWaitMs?: number
}

export function createDeployer(deps: DeployDeps) {
  const pollMs = deps.pollIntervalMs ?? 3000
  /**
   * 15 minutes, raised from 5 on 2026-08-09.
   *
   * THAT RAISE WAS A MISDIAGNOSIS, and it is left here as a worked example
   * rather than quietly corrected. The symptom was real — operator builds
   * reaching READY while the tool reported a timeout — but the cause was not
   * impatience. The poll below compared `row.status` against 'live'/'failed',
   * two values nothing in this system ever writes, so it could not recognise a
   * terminal state at any window length. Widening it only made each doomed
   * deploy waste 15 minutes instead of 5.
   *
   * The lesson worth keeping: "a build that succeeded was reported as a
   * timeout" is evidence that the poll cannot READ the outcome, and the first
   * thing to check is the status vocabulary, not the clock. The actual fix is
   * at the comparison itself.
   *
   * The window still earns its size independently — a frontend build is
   * `npm install` plus a bundle in a cold container, and 5-6 minutes is
   * ordinary. It stays bounded because unbounded would hang a turn forever on
   * a build that genuinely died.
   */
  const maxMs = deps.maxWaitMs ?? 15 * 60 * 1000

  /**
   * Never throws. Every failure is `{ ok: false, error }`, because the
   * dispatch site in loop.ts reads `r.ok` with no try/catch — a throw out of
   * here ends the whole turn.
   *
   * The path that actually escaped was `deps.mcp.call('manage_frontend', …)`.
   * `manage_frontend` is internal-only — absent from both the tool catalogue
   * and the operator policy table — so `turnMcp` refuses it on every operator
   * turn. Observed 2026-08-07: an operator got 371 events in, tried to deploy
   * a frontend, and lost the turn along with the backend work it had already
   * finished. A frontend deploy is best-effort; taking the turn down with it
   * is not.
   */
  async function runDeploy(input: { convId: string; appId: string; jwt: string }) {
      const tree = deps.cache.get(input.convId, input.appId)
      if (!tree || tree.size === 0) return { ok: false as const, error: 'no files to deploy' }

      const zip = new JSZip()
      for (const f of tree.values()) zip.file(f.path, f.content)

      /**
       * The dependency-cache key. Imported, not inlined: the operator's
       * sandbox build (build-hydration.ts) presigns the SAME shared R2 object
       * on this hash, and the baked sandbox image records it too. The rule and
       * the reasons live in install-key.ts.
       *
       * NOTE the behaviour change this import makes explicit rather than
       * introduces: the old loop here kept the LAST lockfile it saw while
       * build-hydration.ts took the FIRST in `LOCKFILE_NAMES` order. They
       * differed only for a tree carrying two lockfiles at once, which is
       * impossible for a scaffolded app (file-ops.ts:23 denies both), but it
       * was a real divergence between two writers of one cache object.
       */
      const lockfile_hash = installKeyFor(tree)
      const zipBuf = await zip.generateAsync({ type: 'uint8array' })

      const create = await deps.mcp.call('manage_frontend', { action: 'create_from_source', app_id: input.appId }, input.jwt)
      const deployment_id: string = create.deployment_id
      const upload_url: string = create.upload_url

      const put = await fetch(upload_url, { method: 'PUT', body: zipBuf as BodyInit, headers: { 'Content-Type': 'application/zip' } })
      if (!put.ok) return { ok: false as const, error: `upload failed: ${put.status}` }

      await deps.mcp.call('manage_frontend', {
        action: 'start_from_source',
        app_id: input.appId,
        deployment_id,
        lockfile_hash,
        build_command: 'npm run build',
        output_dir: 'dist',
        package_manager: 'npm',
      }, input.jwt)
      deps.onDeploymentProgress({ deployment_id, status: 'queued' })

      const started = Date.now()
      while (Date.now() - started < maxMs) {
        await new Promise(r => setTimeout(r, pollMs))
        const listing = await deps.mcp.call('manage_frontend', { action: 'list_deployments', app_id: input.appId }, input.jwt)
        const row = (listing.deployments ?? []).find((d: any) => d.id === deployment_id)
        if (!row) continue
        deps.onDeploymentProgress({
          deployment_id,
          status: row.status,
          url: row.url,
          log_tail: row.log_tail,
          error: row.error,
        })
        /**
         * MATCHED CASE-INSENSITIVELY AND IN BOTH VOCABULARIES, because these
         * two lines used to read `=== 'live'` and `=== 'failed'` and NEITHER
         * COULD EVER BE TRUE.
         *
         * `row.status` is `app_deployments.status` passed through verbatim by
         * `GET /v1/:appId/frontend/deployments`, and the only values anything
         * writes there are WAITING / BUILDING / READY / ERROR — see
         * `build-driver.service.ts` (READY on success, ERROR on failure) and
         * `deployment.service.ts`. The lowercase pair was a vocabulary that
         * exists nowhere in the system.
         *
         * So the loop was unreachable on BOTH branches: every deploy ran the
         * full `maxMs` and returned the timeout string below, whether the build
         * had succeeded, failed, or was still going. The operator was told
         * "timed out" for builds that had already failed in 8 seconds.
         *
         * This is also why raising `maxMs` from 5 to 15 minutes changed
         * nothing. That edit was made on 2026-08-09 against exactly this
         * symptom and misdiagnosed it as a too-short window — see the comment
         * on `maxMs`, which is preserved above with its correction, because the
         * reasoning in it is the trap: "builds reached READY but we reported a
         * timeout" is evidence of a status the poll cannot recognise, not of a
         * poll that is too impatient.
         */
        const status = String(row.status ?? '').toUpperCase()
        if (status === 'READY' || status === 'LIVE') return { ok: true as const, deployment_id, url: row.url }
        if (status === 'ERROR' || status === 'FAILED') {
          return { ok: false as const, error: row.error ?? row.error_message ?? 'build failed' }
        }
      }
      return {
        ok: false as const,
        error:
          // Does NOT tell the caller to "check list_deployments": the operator
          // has no tool that can. `manage_frontend` is deliberately unlisted
          // for operator turns and `manage_app` has no such action, so the
          // advice produced a guaranteed validation error — observed
          // 2026-08-10, the model tried it and got
          // `invalid_enum_value: "received": "list_deployments"`. Advice a
          // reader cannot follow is worse than none; it costs a turn.
          `deployment did not reach a terminal status within ${Math.round(maxMs / 60000)} minutes. ` +
          `It may still be building. Do NOT start another build — that does not cancel this one, ` +
          `and two builds racing on the same app is how a half-shipped deploy happens.`,
      }
  }

  return {
    async deploy(input: { convId: string; appId: string; jwt: string }) {
      try {
        return await runDeploy(input)
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
