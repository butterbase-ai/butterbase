import JSZip from 'jszip'
import { installKeyFor } from './install-key.js'
import type { WorkingTreeCache } from './working-tree.js'

export type DeploymentProgressEvent = {
  deployment_id: string
  status: 'queued' | 'building' | 'live' | 'failed'
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
   * 15 minutes, raised from 5.
   *
   * WHY. A frontend build is `npm install` plus a bundle in a cold container,
   * and on 2026-08-09 three consecutive operator builds landed 5-6 minutes
   * after being started — just outside the old window. Every one of them
   * reached READY. The operator was told each had "timed out", so it deployed
   * again, and again, until the duplicate-call guard ended the turn with a
   * half-shipped feature: a conflicts UI live on the site with no backend
   * function behind it, 404ing on use.
   *
   * That is the failure mode a too-short poll produces here — not a lost
   * deploy, but a SUCCESSFUL deploy reported as a failure to an agent whose
   * natural response is to start another one. The cost of waiting longer is a
   * slower turn; the cost of waiting too little is redundant builds and a
   * corrupted deploy history.
   *
   * Still bounded, because unbounded would hang a turn forever on a build that
   * genuinely died. If this fires now it means something is actually wrong.
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
        if (row.status === 'live') return { ok: true as const, deployment_id, url: row.url }
        if (row.status === 'failed') return { ok: false as const, error: row.error ?? 'build failed' }
      }
      return {
        ok: false as const,
        error:
          `deployment did not reach a terminal status within ${Math.round(maxMs / 60000)} minutes. ` +
          `It may still be building — check list_deployments before deploying again, ` +
          `because starting another build does not cancel this one.`,
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
