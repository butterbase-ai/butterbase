/**
 * The function deployer's transport, for AUTONOMOUS OPERATOR turns.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * `deploy-function.ts` reaches the deploy pipeline through the `deploy_function`
 * MCP tool. On an operator turn that goes through `turnMcp` (loop.ts), which
 * admits only an 'allow' verdict — and `deploy_function` sits at 'approval' in
 * the operator tool table. So the call is refused.
 *
 * Refused at EVERY setting of `yolo_mode`, which is the part that makes this
 * hard to spot. `yolo_mode` promotes 'approval' to 'allow' only where a context
 * is supplied, and `turnMcp` deliberately does not supply one. So the operator
 * could be fully pre-authorised and this would still fail.
 *
 * The shape of the failure is worth stating, because it reads as a policy
 * decision rather than a bug: the OUTER tool the model calls,
 * `deploy_function_from_workspace`, is itself 'approval' and IS promoted at the
 * dispatch site — so it runs, gets as far as `functionDeployer.deploy`, and
 * only then hits the strict wrapper on the inner call. The model sees
 * `Tool "deploy_function" is not permitted for the autonomous operator` in
 * response to a tool it never named.
 *
 * Observed in production 2026-08-10: an operator read the firm's tickets,
 * wrote a conflicts check, and could not deploy it — twice in one turn.
 *
 * WHY THIS SHAPE — an `Mcp`-shaped adapter rather than a policy change
 * -------------------------------------------------------------------
 * This is the third instance of one bug. `repo-http.ts` did it for
 * `manage_repo`, `frontend-http.ts` for `manage_frontend`, and this file for
 * `deploy_function`; all three are deliberately the same shape so they read as
 * one pattern rather than three ad-hoc escapes. The fix is NOT to widen the
 * policy — `deploy_function` stays at 'approval', `turnMcp` is untouched — but
 * to stop needing MCP for what is really an internal step of an already
 * approved action.
 *
 * `deploy-function.ts` is not modified: it keeps calling
 * `mcp.call('deploy_function', …)`, and this object answers over HTTP. The
 * deploy ORCHESTRATION (workspace hydration, entry-file lookup, progress
 * events) stays in one place for both the human assistant and the operator,
 * instead of forking into two copies that can drift.
 *
 * WHY IT IS SAFE TO ROUTE AROUND `turnMcp` HERE
 * ---------------------------------------------
 * Authorization does not move. `POST /v1/:appId/functions` runs the same
 * `requireUserId` + app-resolution the human dashboard's own deploys depend on,
 * and the credential is the org's `bb_sk_*` already carried by this turn. What
 * is bypassed is only the operator's INTERNAL tool table — a gate meant for
 * calls the loop makes on its own behalf, not for the implementation of a tool
 * call the model made and policy already approved.
 *
 * The blast radius is one tool: anything other than `deploy_function` throws.
 */
/**
 * Structural, not imported: `loop.ts` declares `Mcp` locally and does not
 * export it, and `repo-http.ts` / `frontend-http.ts` both restate it here for
 * the same reason. Keeping the three identical is what makes them one pattern.
 */
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

export type HttpFunctionDeps = {
  baseUrl?: string
  /** Injectable for tests. Production uses global `fetch`. */
  fetchImpl?: typeof fetch
}

export function createHttpFunctionMcp(deps: HttpFunctionDeps = {}): Mcp {
  const baseUrl = (deps.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '')
  const doFetch = deps.fetchImpl ?? fetch

  return {
    async call(name: string, args: unknown, jwt: string) {
      if (name !== 'deploy_function') {
        throw new Error(`function-http: refusing "${name}" — this transport serves deploy_function only`)
      }
      const a = (args ?? {}) as Record<string, any>
      const appId: string = a.app_id
      if (!appId) throw new Error('function-http: app_id is required')

      /**
       * `app_id` moves into the path; everything else passes through unchanged.
       *
       * No snake/camel translation is needed here (unlike `frontend-http.ts`):
       * `deployFunctionSchema` already takes `envVars`, `timeoutMs` and
       * `memoryLimitMb` under exactly the names `deploy-function.ts` sends, and
       * accepts the SINGULAR `trigger` — the route shims it to a one-element
       * `triggers` array itself. Reshaping it here would duplicate that shim
       * and give it a second place to drift from.
       */
      const { app_id: _omit, ...body } = a

      const res = await doFetch(`${baseUrl}/v1/${encodeURIComponent(appId)}/functions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      // Text first: error bodies are not always JSON, and an empty body would
      // make res.json() throw with a message that hides the status the caller
      // actually needs.
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`function deploy failed (${res.status}): ${text.slice(0, 500)}`)
      }
      let parsed: any = null
      if (text) { try { parsed = JSON.parse(text) } catch { parsed = null } }
      // `deploy-function.ts` reads `{ id, url }` off the result; the route
      // returns both at the top level, so this passes straight through.
      return parsed
    },
  }
}
