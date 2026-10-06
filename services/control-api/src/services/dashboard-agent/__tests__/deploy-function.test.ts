import { describe, expect, it, vi } from 'vitest'
import { WorkingTreeCache } from '../working-tree'
import { createFunctionDeployer } from '../deploy-function'

const CONV = 'c1', APP = 'a1', JWT = 'jwt'

describe('createFunctionDeployer', () => {
  it('returns entry-file-not-found when no index file exists in the working tree', async () => {
    const cache = new WorkingTreeCache()
    const mcp = { call: vi.fn() }
    const progress: any[] = []

    const deployer = createFunctionDeployer({
      cache,
      mcp,
      onFunctionDeployProgress: (e) => progress.push(e),
    })

    const r = await deployer.deploy({ convId: CONV, appId: APP, jwt: JWT, functionName: 'hello' })

    expect(r).toEqual({ ok: false, error: 'entry file not found' })
    expect(mcp.call).not.toHaveBeenCalled()
    expect(progress.map((p) => p.status)).toEqual(['queued', 'failed'])
    expect(progress[1].error).toBe('entry file not found')
  })

  it('deploys the index.ts entry file and reports queued/uploading/live in order', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'functions/hello/index.ts', 'export function handler() { return new Response("ok") }')
    cache.write(CONV, APP, 'functions/hello/util.ts', 'export const x = 1') // not sent

    const mcp = {
      call: vi.fn(async (name: string, args: any) => {
        expect(name).toBe('deploy_function')
        expect(args).toMatchObject({
          app_id: APP,
          name: 'hello',
          code: 'export function handler() { return new Response("ok") }',
          trigger: { type: 'http' },
        })
        return { ok: true as const, result: { id: 'fn_123', url: 'https://x.butterbase.dev/v1/a1/fn/hello' } }
      }),
    }
    const progress: any[] = []

    const deployer = createFunctionDeployer({
      cache,
      mcp,
      onFunctionDeployProgress: (e) => progress.push(e),
    })

    const r = await deployer.deploy({ convId: CONV, appId: APP, jwt: JWT, functionName: 'hello' })

    expect(r).toEqual({ ok: true, url: 'https://x.butterbase.dev/v1/a1/fn/hello', deploymentId: 'fn_123' })
    expect(progress.map((p) => p.status)).toEqual(['queued', 'uploading', 'live'])
    expect(progress[2].url).toBe('https://x.butterbase.dev/v1/a1/fn/hello')
  })

  it('falls back to index.js when index.ts is absent', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'functions/hello/index.js', 'export function handler() {}')
    const mcp = { call: vi.fn(async () => ({ ok: true as const, result: { id: 'fn_1' } })) }

    const deployer = createFunctionDeployer({ cache, mcp, onFunctionDeployProgress: () => {} })
    const r = await deployer.deploy({ convId: CONV, appId: APP, jwt: JWT, functionName: 'hello' })

    expect(r).toEqual({ ok: true, url: undefined, deploymentId: 'fn_1' })
    expect(mcp.call).toHaveBeenCalledWith('deploy_function', expect.objectContaining({ code: 'export function handler() {}' }), JWT)
  })

  it('emits failed and returns the error on MCP failure', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'functions/hello/index.ts', 'export function handler() {}')
    const mcp = { call: vi.fn(async () => ({ ok: false as const, error: 'boom' })) }
    const progress: any[] = []

    const deployer = createFunctionDeployer({
      cache,
      mcp,
      onFunctionDeployProgress: (e) => progress.push(e),
    })

    const r = await deployer.deploy({ convId: CONV, appId: APP, jwt: JWT, functionName: 'hello' })

    expect(r).toEqual({ ok: false, error: 'boom' })
    expect(progress.map((p) => p.status)).toEqual(['queued', 'uploading', 'failed'])
    expect(progress[2].error).toBe('boom')
  })

  it('passes through optional trigger, envVars, timeoutMs, memoryLimitMb', async () => {
    const cache = new WorkingTreeCache()
    cache.write(CONV, APP, 'functions/cron-job/index.ts', 'export function handler() {}')
    const mcp = { call: vi.fn(async () => ({ ok: true as const, result: { id: 'fn_2' } })) }

    const deployer = createFunctionDeployer({ cache, mcp, onFunctionDeployProgress: () => {} })
    await deployer.deploy({
      convId: CONV,
      appId: APP,
      jwt: JWT,
      functionName: 'cron-job',
      trigger: { type: 'cron', config: { schedule: '0 9 * * *' } },
      envVars: { FOO: 'bar' },
      timeoutMs: 60000,
      memoryLimitMb: 256,
    })

    expect(mcp.call).toHaveBeenCalledWith(
      'deploy_function',
      {
        app_id: APP,
        name: 'cron-job',
        code: 'export function handler() {}',
        trigger: { type: 'cron', config: { schedule: '0 9 * * *' } },
        envVars: { FOO: 'bar' },
        timeoutMs: 60000,
        memoryLimitMb: 256,
      },
      JWT,
    )
  })
})
