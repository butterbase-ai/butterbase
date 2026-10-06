/**
 * repo-sync / schema-context against the REAL MCP tools.
 *
 * repo-sync.test.ts hands createRepoSync flat, hand-written payloads — which
 * is how `download_url` (the consumer's guess) survived for so long while the
 * real manage_repo tool returns `downloadUrl`, and how the "no snapshot yet"
 * isError never got exercised. Here the producer is the actual
 * `registerManageRepo` / `registerManageSchema` from services/mcp-server,
 * mounted on a real SDK McpServer (so a thrown tool handler becomes the SDK's
 * own isError envelope), and each result goes through the same
 * `parseMcpToolResult` defaultMcp() applies. Only the control-api HTTP layer
 * underneath the tool is faked, with the bodies routes/repo.ts actually sends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../store.js', () => ({
  appendMessage: vi.fn(),
  listMessages: vi.fn(),
  getRecentToolArgs: vi.fn(),
  upsertSnapshotLabel: vi.fn(),
  getConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
}))
vi.mock('../mcp-client.js', () => ({ callMcpTool: vi.fn() }))
vi.mock('../approvals-store.js', () => ({ createApproval: vi.fn(), checkTrust: vi.fn() }))

import { parseMcpToolResult } from '../loop.js'
import { createRepoSync } from '../repo-sync.js'
import { fetchAppSchemas } from '../schema-context.js'
import { WorkingTreeCache } from '../working-tree.js'
import { registerManageRepo } from '../../../../../mcp-server/src/tools/manage-repo.js'
import { registerManageSchema } from '../../../../../mcp-server/src/tools/manage-schema.js'

const CONV = 'c1', APP = 'app_1', JWT = 'jwt.example'
const BASE = 'http://control-api.test'
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64)

type Route = (url: string, init?: RequestInit) => Response | undefined
let routes: Route[] = []
const originalFetch = globalThis.fetch
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Exactly what routes/repo.ts sends (createAgentError) for these cases.
const NO_SNAPSHOT_404 = {
  error: {
    code: 'RESOURCE_NOT_FOUND',
    message: 'No snapshots have been pushed for this app',
    remediation: 'Push a snapshot via POST /v1/:app_id/repo/snapshots/prepare + commit.',
    documentation_url: 'https://docs.butterbase.ai/errors/RESOURCE_NOT_FOUND',
  },
}
const APP_NOT_FOUND_404 = {
  error: {
    code: 'RESOURCE_NOT_FOUND',
    message: 'App not found',
    remediation: 'Verify the app_id is correct and that you own it.',
  },
}

async function realMcp() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerManageRepo(server)
  registerManageSchema(server)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  // Same contract as defaultMcp(): transport result → parseMcpToolResult.
  return {
    call: vi.fn(async (name: string, args: unknown, _jwt: string) => {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> })
      return parseMcpToolResult(name, result)
    }),
  }
}

beforeEach(() => {
  process.env.CONTROL_API_URL = BASE
  routes = []
  globalThis.fetch = vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input)
    for (const r of routes) {
      const res = r(url, init)
      if (res) return res
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as any
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.CONTROL_API_URL
})

describe('repo-sync.pullLatest through the real manage_repo tool', () => {
  it('new app (latest snapshot 404) → hydrated:false, so ensureHydrated scaffolds from the template', async () => {
    routes.push((url) =>
      url === `${BASE}/v1/${APP}/repo/snapshots/latest` ? json(404, NO_SNAPSHOT_404) : undefined,
    )
    const cache = new WorkingTreeCache()
    const sync = createRepoSync({ cache, mcp: await realMcp() })

    await expect(sync.pullLatest({ convId: CONV, appId: APP, jwt: JWT })).resolves.toEqual({ hydrated: false })
    expect(cache.get(CONV, APP)).toBeUndefined()
  })

  it('an "App not found" 404 (no access) still throws — it is not an empty repo', async () => {
    routes.push((url) =>
      url === `${BASE}/v1/${APP}/repo/snapshots/latest` ? json(404, APP_NOT_FOUND_404) : undefined,
    )
    const sync = createRepoSync({ cache: new WorkingTreeCache(), mcp: await realMcp() })

    await expect(sync.pullLatest({ convId: CONV, appId: APP, jwt: JWT })).rejects.toThrow(/App not found/)
  })

  it('existing app → fetches each downloadUrl the tool returns and hydrates the full tree', async () => {
    routes.push((url) =>
      url === `${BASE}/v1/${APP}/repo/snapshots/latest`
        ? json(200, {
            snapshot_id: 'snap_1',
            manifest: {
              v: 1,
              files: [
                { path: 'src/App.tsx', sha256: SHA_A, size: 11 },
                { path: 'package.json', sha256: SHA_B, size: 11 },
              ],
            },
          })
        : undefined,
    )
    routes.push((url, init) => {
      if (url !== `${BASE}/v1/${APP}/repo/blobs/batch`) return undefined
      const { shas } = JSON.parse(String(init?.body)) as { shas: string[] }
      return json(200, { blobs: shas.map((s) => ({ sha256: s, size: 11, downloadUrl: `https://r2.test/${s}` })) })
    })
    routes.push((url) => (url === `https://r2.test/${SHA_A}` ? new Response('APP_CONTENT') : undefined))
    routes.push((url) => (url === `https://r2.test/${SHA_B}` ? new Response('PKG_CONTENT') : undefined))

    const cache = new WorkingTreeCache()
    const sync = createRepoSync({ cache, mcp: await realMcp() })

    await expect(sync.pullLatest({ convId: CONV, appId: APP, jwt: JWT })).resolves.toEqual({ hydrated: true })
    expect(cache.read(CONV, APP, 'src/App.tsx')).toBe('APP_CONTENT')
    expect(cache.read(CONV, APP, 'package.json')).toBe('PKG_CONTENT')
  })
})

describe('schema-context.fetchAppSchemas through the real manage_schema tool', () => {
  it('reads tables off the route payload the tool passes through', async () => {
    routes.push((url) =>
      url === `${BASE}/v1/${APP}/schema`
        ? json(200, {
            app_id: APP,
            schema: {
              tables: {
                posts: {
                  columns: {
                    id: { type: 'uuid', primaryKey: true, nullable: false },
                    title: { type: 'text', nullable: false },
                  },
                },
              },
            },
            api_base: `${BASE}/v1/${APP}`,
            _meta: { resource_info: { table_count: 1, tables: ['posts'] } },
          })
        : undefined,
    )

    const out = await fetchAppSchemas([APP], JWT, await realMcp())

    expect(out).toEqual({ [APP]: 'posts(id uuid pk, title text NOT NULL)' })
  })
})
