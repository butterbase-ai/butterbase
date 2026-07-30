import JSZip from 'jszip'
import { createHash } from 'node:crypto'
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
  const maxMs = deps.maxWaitMs ?? 5 * 60 * 1000

  return {
    async deploy(input: { convId: string; appId: string; jwt: string }) {
      const tree = deps.cache.get(input.convId, input.appId)
      if (!tree || tree.size === 0) return { ok: false as const, error: 'no files to deploy' }

      const zip = new JSZip()
      let lockfileContent = ''
      for (const f of tree.values()) {
        zip.file(f.path, f.content)
        if (f.path === 'package-lock.json' || f.path === 'pnpm-lock.yaml' || f.path === 'yarn.lock') {
          lockfileContent = f.content
        }
      }
      if (!lockfileContent) {
        const pkg = tree.get('package.json')?.content ?? ''
        lockfileContent = pkg
      }
      const lockfile_hash = createHash('sha256').update(lockfileContent, 'utf8').digest('hex')
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
      return { ok: false as const, error: 'deployment timed out' }
    },
  }
}
