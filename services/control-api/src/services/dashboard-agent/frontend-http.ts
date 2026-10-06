/**
 * The frontend deployer's transport, for AUTONOMOUS OPERATOR turns.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * `deploy.ts` reaches the build pipeline through `manage_frontend` over MCP.
 * On an operator turn that goes through `turnMcp` (loop.ts), which admits only
 * an 'allow' verdict — and `manage_frontend` is absent from the operator tool
 * table entirely, so the deny-by-default floor resolves it to 'approval' and
 * the call is refused.
 *
 * Refused at EVERY setting of `yolo_mode`, and that part is easy to get wrong.
 * `yolo_mode` promotes 'approval' to 'allow' only where a context is supplied,
 * and `turnMcp` deliberately does not supply one: these are calls the loop
 * makes on its own behalf, with no model proposing them and no ledger row
 * describing them. So the flag cannot rescue this, by design.
 *
 * The consequence, observed 2026-08-07: an operator got 371 events into a turn,
 * wrote a working frontend, and could not ship it.
 *
 * WHY THIS SHAPE — an `Mcp`-shaped adapter rather than a rewrite of deploy.ts
 * ---------------------------------------------------------------------------
 * This is the same move `repo-http.ts` made for `manage_repo`, for the same
 * reason, and it is deliberately the same shape so the two read as one pattern
 * rather than two ad-hoc escapes. The fix is NOT to widen the policy —
 * `manage_frontend` stays unlisted, `turnMcp` is untouched — but to stop
 * needing MCP for a loop-internal call.
 *
 * `deploy.ts` is not modified at all: it keeps calling
 * `mcp.call('manage_frontend', …)`, and this object answers those calls over
 * HTTP. That keeps the deploy ORCHESTRATION (zip, upload, poll, progress
 * events) in exactly one place for both the human assistant and the operator,
 * instead of forking it into two copies that can drift.
 *
 * WHY IT IS SAFE TO ROUTE AROUND `turnMcp` HERE
 * ---------------------------------------------
 * Authorization does not move. Every route below runs `requireUserId` +
 * `AppResolver.resolveApp` — the same lines the human dashboard's own deploys
 * depend on. The credential is the org's `bb_sk_*`, already carried by this
 * turn, which plugins/auth.ts resolves to `{ userId, organizationId }`. So an
 * operator can only deploy to an app in its own org, enforced by the same
 * middleware as everyone else, rather than by anything reimplemented here.
 *
 * DELIBERATELY NOT A GENERAL MCP BYPASS. `call()` accepts exactly one tool
 * name and exactly three actions — the three `deploy.ts` uses — and throws on
 * anything else. Without that, this object would be a hole through which any
 * future caller could reach any tool with the operator's org key and no policy
 * check at all, which is precisely the property `turnMcp` exists to provide.
 * The narrowness is the security control; keep it narrow.
 */

/** Mirrors `deploy.ts`'s local `Mcp` type. */
type Mcp = { call(name: string, args: unknown, jwt: string): Promise<any> }

/**
 * Same resolution order and rationale as `repo-http.ts`'s `defaultBaseUrl` —
 * see that file's header for why this must be the public anycast host on Fly
 * rather than a loopback (`plugins/fly-replay.ts` has to see the request to
 * redirect it to the app's home region).
 */
function defaultBaseUrl(): string {
  return process.env.CONTROL_API_URL ?? process.env.PUBLIC_API_URL ?? 'http://localhost:4000'
}

export type HttpFrontendDeps = {
  baseUrl?: string
  /** Injectable for tests. Production uses global `fetch`. */
  fetchImpl?: typeof fetch
}

export function createHttpFrontendMcp(deps: HttpFrontendDeps = {}): Mcp {
  const baseUrl = (deps.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '')
  const doFetch = deps.fetchImpl ?? fetch

  async function api(method: 'GET' | 'POST', path: string, jwt: string, body?: unknown): Promise<any> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${jwt}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    // Text first: error bodies are not always JSON, and an empty body would
    // make res.json() throw with a message that hides the status the caller
    // actually needs.
    const text = await res.text()
    let parsed: any = null
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
    if (!res.ok) {
      throw new Error(`frontend ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`)
    }
    return parsed
  }

  return {
    async call(name: string, args: unknown, jwt: string) {
      if (name !== 'manage_frontend') {
        throw new Error(`frontend-http: refusing "${name}" — this transport serves manage_frontend only`)
      }
      const a = (args ?? {}) as Record<string, any>
      const appId: string = a.app_id
      if (!appId) throw new Error('frontend-http: app_id is required')
      const enc = encodeURIComponent(appId)

      switch (a.action) {
        case 'create_from_source':
          return api('POST', `/v1/${enc}/frontend/deployments/from-source`, jwt)

        case 'start_from_source': {
          /**
           * SNAKE TO CAMEL, and it is load-bearing. `deploy.ts` speaks the MCP
           * tool's vocabulary (`build_command`, `lockfile_hash`, …) while the
           * route parses `startSchema`, which is camelCase and whose
           * `lockfileHash` is a REQUIRED `/^[a-f0-9]{8,64}$/`. Pass the snake
           * names through untranslated and zod rejects the body — a 400 that
           * reads like a broken build, not like a naming mismatch. The MCP tool
           * does this same translation; this is not an extra layer, it is the
           * layer that moved.
           */
          const depId = encodeURIComponent(a.deployment_id)
          return api('POST', `/v1/${enc}/frontend/deployments/from-source/${depId}/start`, jwt, {
            buildCommand: a.build_command ?? 'npm run build',
            outputDir: a.output_dir ?? 'dist',
            packageManager: a.package_manager ?? 'npm',
            lockfileHash: a.lockfile_hash,
            ...(a.user_env ? { userEnv: a.user_env } : {}),
          })
        }

        case 'list_deployments':
          return api('GET', `/v1/${enc}/frontend/deployments`, jwt)

        default:
          throw new Error(
            `frontend-http: refusing manage_frontend action "${a.action}" — ` +
            `only create_from_source, start_from_source and list_deployments are served here`,
          )
      }
    },
  }
}
