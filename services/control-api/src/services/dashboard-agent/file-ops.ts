import type { WorkingTreeCache } from './working-tree.js'
import type { RepoSync } from './repo-sync.js'

export type FileOpName = 'write_file' | 'read_file' | 'list_files' | 'delete_file'
export type FileChangeEvent = {
  app_id: string
  path: string
  kind: 'write' | 'delete'
  content?: string
  sha256?: string
}
export type FileOpResult = { ok: true; data: unknown } | { ok: false; error: string }

export type FileOpDeps = {
  cache: WorkingTreeCache
  repoSync: RepoSync
  apiUrl: string
  onFileChange(evt: FileChangeEvent): void
  onActiveAppChange(evt: { appId: string; appName?: string }): void
  ensureHydrated(input: { convId: string; appId: string; jwt: string }): Promise<void>
}

const MANAGED_PATHS = new Set(['package.json', 'package-lock.json'])
const MAX_BYTES = 512 * 1024
const ALLOWLIST_MSG =
  'package.json is managed. Use one of the allowlisted libraries: react, react-dom, tailwindcss, lucide-react, clsx, tailwind-merge, class-variance-authority, @butterbase/client.'

function validatePath(path: string): string | null {
  if (!path || path.startsWith('/') || path.includes('..')) return `invalid path: ${path}`
  return null
}

export function createFileOps(deps: FileOpDeps) {
  const lastActiveAppByConv = new Map<string, string>()

  async function beforeMutate(convId: string, appId: string, jwt: string) {
    await deps.ensureHydrated({ convId, appId, jwt })
    if (lastActiveAppByConv.get(convId) !== appId) {
      lastActiveAppByConv.set(convId, appId)
      deps.onActiveAppChange({ appId })
    }
  }

  return {
    async execute(name: FileOpName, args: any, ctx: { convId: string; jwt: string }): Promise<FileOpResult> {
      const appId: string | undefined = args?.app_id
      if (!appId) return { ok: false, error: 'app_id is required' }

      switch (name) {
        case 'write_file': {
          const path: string = args.path
          const content: string = args.content ?? ''
          const pv = validatePath(path)
          if (pv) return { ok: false, error: pv }
          if (MANAGED_PATHS.has(path)) return { ok: false, error: ALLOWLIST_MSG }
          if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
            return { ok: false, error: `file exceeds ${MAX_BYTES} bytes` }
          }
          await beforeMutate(ctx.convId, appId, ctx.jwt)
          const wf = deps.cache.write(ctx.convId, appId, path, content)
          deps.onFileChange({ app_id: appId, path, kind: 'write', content, sha256: wf.sha256 })
          return { ok: true, data: { path, sha256: wf.sha256, size: Buffer.byteLength(content, 'utf8') } }
        }
        case 'read_file': {
          const path: string = args.path
          const pv = validatePath(path)
          if (pv) return { ok: false, error: pv }
          await beforeMutate(ctx.convId, appId, ctx.jwt)
          const content = deps.cache.read(ctx.convId, appId, path)
          if (content === undefined) return { ok: false, error: `not found: ${path}` }
          return { ok: true, data: { path, content } }
        }
        case 'list_files': {
          await beforeMutate(ctx.convId, appId, ctx.jwt)
          return { ok: true, data: { files: deps.cache.list(ctx.convId, appId) } }
        }
        case 'delete_file': {
          const path: string = args.path
          const pv = validatePath(path)
          if (pv) return { ok: false, error: pv }
          if (MANAGED_PATHS.has(path)) return { ok: false, error: ALLOWLIST_MSG }
          await beforeMutate(ctx.convId, appId, ctx.jwt)
          const removed = deps.cache.delete(ctx.convId, appId, path)
          if (!removed) return { ok: false, error: `not found: ${path}` }
          deps.onFileChange({ app_id: appId, path, kind: 'delete' })
          return { ok: true, data: { path } }
        }
      }
    },
  }
}
