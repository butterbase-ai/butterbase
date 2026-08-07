/**
 * Agent loop for the Butterbase Dashboard Assistant.
 *
 * runAgentTurn:  user turn → stream tokens → tool calls → tool results → repeat
 * streamChatCompletion: wraps the AI gateway's /v1/chat/completions SSE endpoint.
 *
 * Task 7 integration:
 *   - File-op tools (write/read/list/delete_file) are dispatched in-process via
 *     `fileOps.execute()` — they never hit MCP.
 *   - The deploy_frontend tool is dispatched in-process via `deployer.deploy()`.
 *   - A module-level `WorkingTreeCache` singleton is reused across requests.
 *   - `ensureHydrated` pulls the app's current repo snapshot (via manage_repo)
 *     and, on empty repos, scaffolds from the template.
 *   - End-of-turn: flush all touched apps back to manage_repo, and record
 *     per-turn usage counters (tokens + tool_calls + writes + deploys).
 */

import pg from 'pg';
import { createHash, randomUUID } from 'crypto';
import { appendMessage, listMessages, upsertSnapshotLabel, getConversation, updateConversationTitle, type Message } from './store.js';
import { getToolCatalog, isFileOpTool, isDeployTool, isDeployFunctionTool, isOperatorScratchpadTool, isRunSandboxCodeTool, OPERATOR_SANDBOX_CODE_TOOL, sensitivityFor, type ToolSpec } from './tool-catalog.js';
import { callMcpTool } from './mcp-client.js';
import { createApproval, checkTrust, createSubstrateEscalationApproval } from './approvals-store.js';
import { logOperatorCheckpoint } from './operator-turn.js';
import { readSubstrateEscalation } from './substrate-approval-bridge.js';
import { isOperatorUserId, operatorOrgIdFromUserId } from './operator-store.js';
import { operatorPolicyForOrg, isOperatorToolAllowed, OPERATOR_LOCAL_TOOLS } from './operator-policy.js';
import { setOperatorScratchpad } from './operator-scratchpad-store.js';
import { trimOperatorHistory } from './operator-history.js';
import { getSystemPrompt } from './prompt.js';
import { getRecentAppIds, fetchAppSchemasCached, buildSchemaPromptBlock } from './schema-context.js';
import { WorkingTreeCache } from './working-tree.js';
import { createFileOps, type FileOpName } from './file-ops.js';
import { createRepoSync, type RepoSync } from './repo-sync.js';
import { createDeployer } from './deploy.js';
import { createFunctionDeployer } from './deploy-function.js';
import { loadTemplate as loadTemplateDefault } from './template-loader.js';
import { recordUsage as recordUsageDefault, type UsageRow } from './usage-store.js';
import { deriveSnapshotTitle, createGatewayChat, type SnapshotTitleGateway } from './snapshot-title.js';
import { generateConversationTitle } from './conversation-title.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; result?: unknown; error?: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string; code?: string; availableUsd?: number; requiredUsd?: number }
  | { type: 'file_change'; app_id: string; path: string; kind: 'write' | 'delete'; content?: string; sha256?: string }
  | { type: 'active_app_change'; app_id: string; app_name?: string }
  | { type: 'deployment_progress'; deployment_id: string; status: 'queued' | 'building' | 'live' | 'failed'; url?: string; log_tail?: string; error?: string }
  | { type: 'function_deployment_progress'; function_name: string; status: 'queued' | 'uploading' | 'live' | 'failed'; url?: string; error?: string }
  | { type: 'approval_required'; approval_id: string; tool_name: string; args: unknown; sensitivity: 'confirm' | 'destructive' }
  | { type: 'title_updated'; title: string };

/** Thrown by streamChatCompletion when the gateway returns a 402 credits error. */
export class InsufficientCreditsStreamError extends Error {
  readonly code = 'insufficient_credits' as const;
  readonly availableUsd?: number;
  readonly requiredUsd?: number;
  constructor(opts: { availableUsd?: number; requiredUsd?: number }) {
    super('insufficient_credits');
    this.name = 'InsufficientCreditsStreamError';
    this.availableUsd = opts.availableUsd;
    this.requiredUsd = opts.requiredUsd;
  }
}

// ---------------------------------------------------------------------------
// Injectable deps (module-level singletons by default)
// ---------------------------------------------------------------------------

type Mcp = { call(name: string, args: unknown, jwt: string): Promise<any> };

export type LoopDeps = {
  cache: WorkingTreeCache;
  mcp: Mcp;
  repoSync: RepoSync;
  recordUsage: (pool: pg.Pool, row: UsageRow) => Promise<void>;
  loadTemplate: (input: { appId: string; apiUrl: string }) => Promise<Array<{ path: string; content: string }>>;
  // Optional preconstructed per-turn factories (tests can inject fully-formed spies).
  // If omitted, they are built per-turn from the primitives above.
  fileOpsFactory?: (emit: (evt: LoopEvent) => void, ensureHydrated: (i: { convId: string; appId: string; jwt: string }) => Promise<void>) => ReturnType<typeof createFileOps>;
  deployerFactory?: (emit: (evt: LoopEvent) => void) => ReturnType<typeof createDeployer>;
  functionDeployerFactory?: (emit: (evt: LoopEvent) => void) => ReturnType<typeof createFunctionDeployer>;
  // Task 5 (Plan 3d): snapshot auto-naming. Tests can inject a stub gateway
  // and/or a spy for the store write; production builds a real gateway chat
  // client bound to the request's JWT and use the real store.upsertSnapshotLabel.
  snapshotTitleGatewayFactory?: (jwt: string) => SnapshotTitleGateway;
  upsertSnapshotLabel?: typeof upsertSnapshotLabel;
  // Task 2 (Plan 3e): conversation auto-titling. Tests can inject spies for
  // the store reads/writes; production uses the real store functions.
  getConversation?: typeof getConversation;
  updateConversationTitle?: typeof updateConversationTitle;
};

let _sharedCache: WorkingTreeCache | undefined;
export function getSharedWorkingTreeCache(): WorkingTreeCache {
  if (!_sharedCache) _sharedCache = new WorkingTreeCache();
  return _sharedCache;
}

function defaultMcp(): Mcp {
  return {
    async call(name: string, args: unknown, jwt: string) {
      const r = await callMcpTool(name, args, jwt);
      if (!r.ok) throw new Error(r.error ?? 'mcp call failed');
      return r.result;
    },
  };
}

let _defaultDeps: LoopDeps | undefined;
function getDefaultDeps(): LoopDeps {
  if (!_defaultDeps) {
    const cache = getSharedWorkingTreeCache();
    const mcp = defaultMcp();
    const repoSync = createRepoSync({ cache, mcp });
    _defaultDeps = {
      cache,
      mcp,
      repoSync,
      recordUsage: recordUsageDefault,
      loadTemplate: loadTemplateDefault,
      snapshotTitleGatewayFactory: createGatewayChat,
      upsertSnapshotLabel,
      getConversation,
      updateConversationTitle,
    };
  }
  return _defaultDeps;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'usage'; prompt_tokens: number; completion_tokens: number };

interface GatewayMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deeply sort object keys so that logically-equal argument objects (regardless
 * of key insertion order) produce identical JSON — and therefore identical hashes.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute a stable sha256 hash of a tool call's args, independent of key order.
 * Used by the per-turn retry budget (Task 5) to detect the agent repeatedly
 * invoking the same tool with the same arguments.
 */
function hashToolArgs(args: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(args ?? {}));
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Convert persisted store messages to the gateway's OpenAI-compatible format.
 */
function toGatewayMessages(messages: Message[]): GatewayMessage[] {
  return messages.map((msg): GatewayMessage => {
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId ?? '',
        content: JSON.stringify(msg.toolResult ?? {}),
      };
    }
    if (msg.role === 'assistant' && msg.toolCallId) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: [
          {
            id: msg.toolCallId,
            type: 'function',
            function: {
              name: msg.toolName ?? '',
              arguments: JSON.stringify(msg.toolArgs ?? {}),
            },
          },
        ],
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

/**
 * Stream chat completions from the AI gateway.
 * Yields token, tool_call, and (optionally) usage chunks.
 */
export async function* streamChatCompletion(opts: {
  model: string;
  messages: GatewayMessage[];
  tools: ToolSpec[];
  jwt: string;
}): AsyncGenerator<StreamChunk> {
  const url = `${process.env.AI_GATEWAY_URL ?? 'http://localhost:3000'}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.jwt}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok) {
    if (res.status === 402) {
      const body = (await res.json().catch(() => null)) as
        // `balance_usd` is the current field; `available_usd` is a DEPRECATED
        // alias the gateway still emits for one release. `required_usd` no
        // longer exists — admission is now "balance below the org's credit
        // floor," not a padded cost estimate — so there is nothing honest to
        // put there and we never fabricate one.
        | { error?: { code?: string; type?: string; balance_usd?: number; available_usd?: number } }
        | null;
      const e = body?.error;
      if (e && (e.code === 'insufficient_credits' || e.type === 'billing_error')) {
        throw new InsufficientCreditsStreamError({
          // Prefer the new field; fall back to the deprecated alias so older
          // gateway deployments (or the transition window) still populate it.
          availableUsd: e.balance_usd ?? e.available_usd,
        });
      }
    }
    /**
     * Carry the gateway's OWN message, not just the status code.
     *
     * A bare `gateway 404` cost a live probe to diagnose: the operator's
     * default model id was unroutable, and the only signal anywhere was an
     * `errors` counter with no detail. The gateway had said exactly what was
     * wrong — `{"error":{"message":"Model not found: …","code":"model_not_found"}}`
     * — and we threw it away. Unattended callers (the operator) have no human
     * watching a stream, so the message is all they ever get.
     *
     * The `gateway <status>` PREFIX is preserved deliberately: existing callers
     * and tests match on the status, and this is purely additive. Reading the
     * body is best-effort — a body that is absent, unreadable, already consumed
     * by the 402 branch above, or not JSON must never turn an HTTP error into a
     * different error.
     */
    let detail = '';
    try {
      const raw = typeof res.text === 'function' ? await res.text() : '';
      if (raw) {
        let msg = raw;
        try {
          const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
          const e = parsed?.error;
          if (typeof e === 'string') msg = e;
          else if (e && typeof e.message === 'string') msg = e.message;
        } catch {
          // Not JSON — fall back to the raw body.
        }
        detail = `: ${msg.slice(0, 500)}`;
      }
    } catch {
      detail = '';
    }
    throw new Error(`gateway ${res.status}${detail}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
  let sawToolCallsFinish = false;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }

        // Usage frame — emitted as the final chunk when stream_options.include_usage is set.
        if (chunk.usage) {
          yield {
            type: 'usage',
            prompt_tokens: chunk.usage.prompt_tokens ?? 0,
            completion_tokens: chunk.usage.completion_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        if (delta?.content) {
          yield { type: 'token', text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: '', name: '', args: '' });
            }
            const acc = toolCallAccum.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }

        if (choice.finish_reason === 'tool_calls') {
          sawToolCallsFinish = true;
          for (const [, acc] of toolCallAccum) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(acc.args);
            } catch {
              parsedArgs = {};
            }
            yield { type: 'tool_call', id: acc.id, name: acc.name, args: parsedArgs };
          }
          toolCallAccum.clear();
        }
      }
    }
  }

  if (!sawToolCallsFinish && toolCallAccum.size > 0) {
    for (const [, acc] of toolCallAccum) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(acc.args);
      } catch {
        parsedArgs = {};
      }
      yield { type: 'tool_call', id: acc.id, name: acc.name, args: parsedArgs };
    }
  }
}

// ---------------------------------------------------------------------------
// Main export: runAgentTurn
// ---------------------------------------------------------------------------

// Unlimited by default — builder-mode chains 20+ tool calls per turn routinely
// and the LLM's own context window is the real ceiling. Env-overridable so a
// runaway can still be capped without a code change.
const TOOL_CALL_LIMIT = process.env.DASHBOARD_AGENT_TOOL_CALL_LIMIT
  ? Number.parseInt(process.env.DASHBOARD_AGENT_TOOL_CALL_LIMIT, 10)
  : Number.POSITIVE_INFINITY;

// Per-turn retry budget: if the agent invokes the same tool with the exact
// same (canonicalized) args this many times in a row, the loop assumes it's
// stuck and stops rather than burning further tool calls. Env-overridable.
const TOOL_RETRY_LIMIT = process.env.DASHBOARD_AGENT_TOOL_RETRY_LIMIT
  ? Number.parseInt(process.env.DASHBOARD_AGENT_TOOL_RETRY_LIMIT, 10)
  : 3;

/**
 * Narrow a `manage_app` action:"list" MCP result to a single org. The tool
 * returns `{ content: [{ type: 'text', text: <json> }] }` where the JSON is
 * `{ apps: [{ ..., organization_id }] }` (each row already carries its owning
 * org — see routes/init.ts `/apps`). We parse that text, keep only rows whose
 * `organization_id` matches, and re-serialize. Any shape mismatch or parse
 * error returns the original result unchanged, so scoping can never break the
 * tool call — it only ever removes cross-org rows.
 */
export function scopeAppListToOrg(result: unknown, orgId: string): unknown {
  try {
    const envelope = result as { content?: Array<{ type?: string; text?: string }> };
    const content = envelope?.content;
    if (!Array.isArray(content)) return result;
    const idx = content.findIndex((c) => c?.type === 'text' && typeof c.text === 'string');
    if (idx === -1) return result;
    const parsed = JSON.parse(content[idx].text as string) as {
      apps?: Array<{ organization_id?: string | null }>;
    };
    if (!parsed || !Array.isArray(parsed.apps)) return result;
    const apps = parsed.apps.filter((a) => a?.organization_id === orgId);
    const nextText = JSON.stringify({ ...parsed, apps }, null, 2);
    const nextContent = content.map((c, i) => (i === idx ? { ...c, text: nextText } : c));
    return { ...envelope, content: nextContent };
  } catch {
    return result;
  }
}

export async function* runAgentTurn(
  input: {
    conversationId: string;
    userId: string;
    jwt: string;
    userMessage: string;
    model: string;
    pool: pg.Pool;
    // Active org (from the dashboard's `x-organization-id` header). When set,
    // the agent's app-discovery tooling (manage_app list) is scoped to it so
    // the model only sees apps in the org the user is currently working in.
    organizationId?: string | null;
    /**
     * Executes model-authored code in an isolated sandbox for this turn.
     * Supplied by `SandboxRunner` (cron-scheduler), absent for `LocalRunner`
     * and for every human/assistant turn.
     *
     * SAFETY-CRITICAL: there is no host-execution fallback. When this is
     * absent, `OPERATOR_SANDBOX_CODE_TOOL` must be absent from the catalog
     * offered to the model (see the `tools` construction below) — never
     * degrade to running code in this process.
     */
    codeExecutor?: (code: string) => Promise<{ stdout: string; stderr: string }>;
    /**
     * Distributed trace id for this turn (see operator-turn.ts). Supplied by
     * `runOperatorTurn`; absent for the human assistant, which has no trace.
     * Threaded into the actual MCP tool dispatch below as the
     * `x-butterbase-trace-id` header, and used to tag the `acted`/`gated`
     * structured checkpoint logs.
     *
     * NOT threaded into `deps.mcp` / `turnMcp` (the loop-internal MCP calls
     * `repoSync` and `fetchAppSchemasCached` make via `Mcp.call`) — those
     * calls don't even carry `x-organization-id` today (`defaultMcp` calls
     * `callMcpTool(name, args, jwt)` with no org, no trace), so adding a
     * trace header there alone would be new plumbing for a pre-existing gap
     * this task did not set out to close. See the D1 report for the explicit
     * "where the id is threaded and where it is not" boundary.
     */
    traceId?: string;
    /**
     * Provenance for anything this turn writes to the substrate ledger — the
     * operator job name, the wake reason, the trace id. Forwarded to the MCP
     * dispatch as a header so the model never sees it and cannot be asked to
     * pass it (an optional field the agent must remember is a field the agent
     * skips). Absent for the human assistant, whose actions are by definition
     * user-instructed.
     */
    triggerContext?: Record<string, unknown>;
  },
  depsOverride?: Partial<LoopDeps>,
): AsyncGenerator<LoopEvent> {
  const base = getDefaultDeps();
  const deps: LoopDeps = { ...base, ...(depsOverride ?? {}) };
  const { cache, recordUsage, loadTemplate } = deps;
  const snapshotTitleGatewayFactory = deps.snapshotTitleGatewayFactory ?? createGatewayChat;
  const upsertSnapshotLabelFn = deps.upsertSnapshotLabel ?? upsertSnapshotLabel;
  const getConversationFn = deps.getConversation ?? getConversation;
  const updateConversationTitleFn = deps.updateConversationTitle ?? updateConversationTitle;

  // Is this the headless operator? Derived from the identity itself rather than
  // from a flag threaded through `input`.
  //
  // A caller can of course pass the wrong `userId` just as easily as it could
  // forget a flag — this is not magic. What makes it safe in practice is that
  // `operator-turn.ts` is the SOLE operator entry point and hardcodes
  // `operatorUserId(job.organizationId)`. What deriving buys over a flag is the
  // failure DIRECTION: a flag's absent/default value means "not an operator",
  // so a new call site that omitted it would run unattended with an org service
  // key and no policy at all — failing open. There is no value of `userId` that
  // silently disables the policy for a turn that is otherwise an operator turn.
  const isOperator = isOperatorUserId(input.userId);

  /**
   * The org this operator turn is FOR, read back out of the same sentinel that
   * decided `isOperator`. Used only by the cross-org guard inside
   * `operatorPolicyForOrg`: any tool call carrying an explicit `org_id`
   * argument that is not this org is denied. `null` for human turns, where the
   * guard is not consulted at all.
   */
  const operatorOrgId = operatorOrgIdFromUserId(input.userId);

  /**
   * The loop makes MCP calls the MODEL did not ask for. They go through
   * `deps.mcp` (default: `defaultMcp()` → the same `callMcpTool`), not through
   * the dispatch site, so the policy check there never sees them:
   *
   *   - `fetchAppSchemasCached` → `manage_schema` action="get", on EVERY turn
   *     for any app id in recent tool args. Operator-allowlisted tools all take
   *     `app_id`, so this fires in normal operation.
   *   - `repoSync` → `manage_repo` pull_latest / pull_snapshot / push.
   *
   * For operator turns `deps.mcp` is therefore replaced with a policy-enforcing
   * wrapper. Only an 'allow' verdict passes: these are internal calls with no
   * model in the loop and no turn to pause, so 'approval' is refused here too
   * rather than silently executed. `defaultMcp`'s contract is to throw on
   * failure and every caller already treats a throw as best-effort — schema
   * injection is wrapped in try/catch and skips per-app, the flush loop logs and
   * continues — so a refusal degrades the turn, it does not break it.
   */
  const turnMcp: Mcp = isOperator
    ? {
        async call(name: string, args: unknown, jwt: string) {
          // Loop-internal tools have no MCP counterpart; an internal caller
          // asking for one by name is a bug, not a permitted call.
          if (OPERATOR_LOCAL_TOOLS.has(name) || operatorPolicyForOrg(name, args, operatorOrgId) !== 'allow') {
            throw new Error(`Tool "${name}" is not permitted for the autonomous operator.`);
          }
          return deps.mcp.call(name, args, jwt);
        },
      }
    : deps.mcp;

  /**
   * `repoSync` must be rebuilt on `turnMcp` for operator turns, not merely
   * assumed unreachable.
   *
   * The default `repoSync` is constructed in `getDefaultDeps` around the RAW
   * client, so it is the one `deps.mcp` consumer that would still hold it. It is
   * reachable only from the file-op / deploy / deploy_function routes and the
   * end-of-turn flush they populate — all of whose tool names are currently
   * denied to the operator. But that is a property of the current contents of
   * OPERATOR_TOOL_ALLOWLIST, not of this code: add any workspace-touching tool
   * to that allowlist later and the operator would silently gain `manage_repo`
   * on the org service key, with nothing failing. Rebuilding here converts a
   * code-reading argument into an invariant.
   *
   * An explicitly injected `repoSync` is honoured as-is: it is the caller's own
   * object, never the raw default client, and silently discarding it would
   * break dependency injection for every future operator test.
   */
  const repoSync: RepoSync =
    isOperator && !depsOverride?.repoSync
      ? createRepoSync({ cache, mcp: turnMcp })
      : deps.repoSync;

  // 1. Persist the user turn
  await appendMessage(input.pool, input.conversationId, {
    role: 'user',
    content: input.userMessage,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    toolResult: null,
  });

  // AFFORDANCE (not the control): hide tools the operator may not call, so the
  // model doesn't waste turns and tokens on refusals. The control is
  // `operatorVerdict` at the dispatch site below, which refuses a denied tool
  // whether or not it was ever in this list — including a name the model
  // invented. Never rely on this filter for safety.
  //
  // The non-operator branch drops `operatorOnly` specs so the human
  // assistant's tool list is exactly what it was before operator-only tools
  // existed. This filter IS load-bearing for the assistant (it is what keeps
  // its catalog unchanged); it is only an affordance on the operator side.
  // SAFETY-CRITICAL, not merely an affordance, for ONE entry in this filtered
  // list: `OPERATOR_SANDBOX_CODE_TOOL`. `operatorPolicyFor` returns 'allow' for
  // it unconditionally (see operator-policy.ts's justification) because the
  // policy table has no way to know whether a `codeExecutor` exists for this
  // turn — that knowledge lives here, on `input`, not in the policy module.
  // So this filter is the ONLY place that decides whether the tool is even
  // reachable: drop it whenever `codeExecutor` is absent, so a turn with no
  // sandbox (LocalRunner, or a SandboxRunner turn that fell back) never offers
  // a tool it has no way to honour except by running code on this host, which
  // must never happen. `allowedToolNames`, derived from this same list below,
  // is what the dispatch guard ultimately checks — so this exclusion is
  // enforced twice: the model is never shown the tool, and even a hallucinated
  // call to it is refused before the dispatch route below is ever reached.
  const tools = isOperator
    ? getToolCatalog()
        .filter((t) => isOperatorToolAllowed(t.name))
        .filter((t) => t.name !== OPERATOR_SANDBOX_CODE_TOOL || typeof input.codeExecutor === 'function')
    : getToolCatalog().filter((t) => t.operatorOnly !== true);

  /**
   * One line per operator turn recording what the model was actually offered.
   * The sandbox tool's presence is turn-local state (`input.codeExecutor`), so
   * it cannot be inferred from config or from the catalog module — without
   * this, "was the tool offered on this wake" is unanswerable after the fact,
   * and the safety-critical filter above has no observable trace at all.
   * Operator-only, so the human assistant's request path is unchanged.
   */
  if (isOperator) {
    console.log('[dashboard-agent] operator tool catalog', {
      conversationId: input.conversationId,
      tools: tools.length,
      sandboxCode: tools.some((t) => t.name === OPERATOR_SANDBOX_CODE_TOOL),
    });
  }

  // Per-turn state --------------------------------------------------------
  const touchedApps = new Set<string>();
  const baselineByApp = new Map<string, Map<string, string>>();
  let toolCallsCount = 0;
  let fileWritesCount = 0;
  let deploymentsCount = 0;
  let gatewayPromptTokens = 0;
  let gatewayCompletionTokens = 0;
  // Task 5: per-turn tool-call retry tracking — keyed by tool name, tracks the
  // hash of the last args seen for that tool and how many consecutive times
  // in a row that same hash has been retried.
  const retryState = new Map<string, { lastArgsHash: string; retries: number }>();

  // SSE queue: file-ops / deployer emit callbacks push events that need to be
  // interleaved with the loop's own yields. We drain the queue after each
  // in-process tool invocation.
  const pendingEvents: LoopEvent[] = [];
  const emit = (evt: LoopEvent) => { pendingEvents.push(evt); };

  const apiUrl = process.env.PUBLIC_API_URL ?? 'https://api.butterbase.dev';

  // ensureHydrated captures the baseline the first time an app is touched.
  const ensureHydrated = async ({ convId, appId, jwt }: { convId: string; appId: string; jwt: string }) => {
    if (!cache.get(convId, appId)) {
      const r = await repoSync.pullLatest({ convId, appId, jwt });
      if (!r.hydrated) {
        // Capture baseline BEFORE scaffold so every template file counts as
        // "new" and is included in the end-of-turn push to manage_repo.
        if (!baselineByApp.has(appId)) {
          baselineByApp.set(appId, cache.snapshotBaseline(convId, appId));
        }
        const files = await loadTemplate({ appId, apiUrl });
        for (const f of files) cache.write(convId, appId, f.path, f.content);
      }
    }
    if (!baselineByApp.has(appId)) {
      baselineByApp.set(appId, cache.snapshotBaseline(convId, appId));
    }
  };

  // Build per-turn fileOps + deployer bound to our SSE queue.
  const fileOps = deps.fileOpsFactory
    ? deps.fileOpsFactory(emit, ensureHydrated)
    : createFileOps({
        cache,
        repoSync,
        apiUrl,
        onFileChange: (evt) => emit({ type: 'file_change', ...evt }),
        onActiveAppChange: (evt) => emit({ type: 'active_app_change', app_id: evt.appId, app_name: evt.appName }),
        ensureHydrated,
      });

  const deployer = deps.deployerFactory
    ? deps.deployerFactory(emit)
    : createDeployer({
        cache,
        mcp: turnMcp,
        onDeploymentProgress: (evt) => emit({ type: 'deployment_progress', ...evt }),
      });

  // createFunctionDeployer's Mcp contract never throws (returns {ok:false,error}
  // instead) — deps.mcp (the loop's default) throws on failure, so adapt it here.
  const functionDeployer = deps.functionDeployerFactory
    ? deps.functionDeployerFactory(emit)
    : createFunctionDeployer({
        cache,
        mcp: {
          async call(name: string, args: unknown, jwt: string) {
            try {
              const result = await turnMcp.call(name, args, jwt);
              return { ok: true as const, result };
            } catch (e) {
              return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
            }
          },
        },
        onFunctionDeployProgress: (evt) => emit({ type: 'function_deployment_progress', ...evt }),
      });

  const history = await listMessages(input.pool, input.conversationId);

  // Task 5 (Plan 3d): turn number for the `Turn <N>` snapshot-title fallback.
  // history already includes the user message just persisted above, so
  // roughly two history rows (user + assistant) per completed turn.
  const turnNumber = Math.max(1, Math.ceil(history.length / 2));

  // Live schema injection (Plan 3a Task 4): prepend a compact summary of the
  // current schema for every app_id the agent has recently touched, so the
  // model doesn't hallucinate column names from stale conversation history.
  // Per-turn cache only — schemas can change between turns via manage_schema.apply.
  const schemaCache = new Map<string, string>();
  let schemaPromptBlock = '';
  try {
    const recentAppIds = await getRecentAppIds(input.pool, input.conversationId);
    if (recentAppIds.length > 0) {
      const schemasByAppId = await fetchAppSchemasCached(recentAppIds, input.jwt, turnMcp, schemaCache);
      schemaPromptBlock = buildSchemaPromptBlock(schemasByAppId);
    }
  } catch {
    // Schema injection is best-effort — never block the turn on it.
  }

  /**
   * I2: bound what an OPERATOR turn replays.
   *
   * One operator conversation per org, reused forever, woken ~144x/day —
   * replaying the whole transcript is a scheduled context-window failure. The
   * scratchpad and the wake header now carry the continuity, so a suffix is
   * enough. `trimOperatorHistory` picks a PAIRING-VALID cut (see its header):
   * it can never emit an assistant `tool_calls` whose result was trimmed away,
   * nor an orphan `role:'tool'` row — the wedge that bricks an org's operator
   * permanently.
   *
   * Nothing is deleted; `history` above is still the full stored record, and
   * `turnNumber` is deliberately computed from it so the snapshot-title
   * fallback does not reset when the replay window slides.
   *
   * FOR A HUMAN CONVERSATION THIS IS THE SAME ARRAY BY IDENTITY. The assistant
   * replays exactly what it replayed before — `toGatewayMessages(history)`,
   * every row, same order. Do not "simplify" this into an unconditional call.
   */
  const replayHistory = isOperator ? trimOperatorHistory(history) : history;

  const messages: GatewayMessage[] = [
    { role: 'system', content: schemaPromptBlock + getSystemPrompt() },
    ...toGatewayMessages(replayHistory),
  ];

  // Yield and drain any queued SSE events (file_change / active_app_change /
  // deployment_progress) — flushed after every fileOps/deployer invocation.
  function* drainPending(): Generator<LoopEvent> {
    while (pendingEvents.length) yield pendingEvents.shift()!;
  }

  // 2. Agentic loop -------------------------------------------------------
  let terminated = false;
  // Task 5 (Plan 3d): last assistant text produced this turn, used as the
  // "Assistant: <chunk>" half of the snapshot-title summarization prompt.
  let lastAssistantText = '';
  // D1: `acted` fires once per turn, on the FIRST tool this turn actually
  // dispatches — not once per tool call — so a turn making several calls
  // produces one `acted` line, not a flood. Declared outside the `outer`
  // loop (a turn can span several model round-trips) and outside the
  // per-round tool-call loop (several tools can dispatch in one round).
  let actedLogged = false;
  try {
    outer: for (let step = 0; step < TOOL_CALL_LIMIT; step++) {
      let assistantText = '';
      const pendingToolCalls: Array<{ id: string; name: string; args: unknown }> = [];

      const stream = streamChatCompletion({
        model: input.model,
        messages,
        tools,
        jwt: input.jwt,
      });

      try {
        for await (const chunk of stream) {
          if (chunk.type === 'token') {
            assistantText += chunk.text;
            yield { type: 'token', text: chunk.text };
          } else if (chunk.type === 'tool_call') {
            pendingToolCalls.push(chunk);
          } else if (chunk.type === 'usage') {
            gatewayPromptTokens += chunk.prompt_tokens;
            gatewayCompletionTokens += chunk.completion_tokens;
          }
        }
      } catch (err: unknown) {
        if (assistantText) lastAssistantText = assistantText;
        if (assistantText) {
          try {
            await appendMessage(input.pool, input.conversationId, {
              role: 'assistant',
              content: assistantText,
              toolCallId: null,
              toolName: null,
              toolArgs: null,
              toolResult: null,
              modelUsed: input.model,
            });
          } catch {
            // Swallow persistence error so original error survives.
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof InsufficientCreditsStreamError) {
          yield {
            type: 'error',
            message,
            code: err.code,
            availableUsd: err.availableUsd,
            requiredUsd: err.requiredUsd,
          };
        } else {
          yield { type: 'error', message };
        }
        terminated = true;
        break outer;
      }

      // No tool call — assistant is done
      if (pendingToolCalls.length === 0) {
        lastAssistantText = assistantText;
        await appendMessage(input.pool, input.conversationId, {
          role: 'assistant',
          content: assistantText,
          toolCallId: null,
          toolName: null,
          toolArgs: null,
          toolResult: null,
          modelUsed: input.model,
        });
        yield { type: 'assistant_message', content: assistantText };
        yield { type: 'done' };
        terminated = true;
        break outer;
      }

      const allowedToolNames = new Set(tools.map((t) => t.name));
      const toolCallResults: Array<{ id: string; result?: unknown; error?: string }> = [];
      for (let i = 0; i < pendingToolCalls.length; i++) {
        const tc = pendingToolCalls[i];

        /**
         * THE CONTROL. For operator turns the policy table decides, per
         * (tool, args), before anything is dispatched. Computed once here and
         * consulted twice: 'approval' pauses immediately below, 'deny' refuses
         * at the dispatch guard further down (which is where the assistant
         * tool-call row has already been persisted, so the refusal can be
         * written back as a tool RESULT and the model can adapt).
         *
         * `null` for a human conversation — nothing below this line changes
         * behaviour for the assistant.
         *
         * `operatorPolicyForOrg` is the table PLUS the cross-org guard: a tool
         * call carrying an explicit `org_id` argument for any org other than
         * this operator's is 'deny'. That argument overrides the
         * `x-organization-id` header `callMcpTool` sets, so without this the
         * only thing keeping the operator's own dispatch inside its org was the
         * stored credential being org-bound — an external property, not a
         * control.
         */
        const operatorVerdict = isOperator
          ? operatorPolicyForOrg(tc.name, tc.args, operatorOrgId)
          : null;

        // Sensitivity gate (Plan 3b Task 2): destructive/confirm-tier calls
        // pause the turn for explicit user approval, unless the conversation
        // has already granted conversation-wide trust for this exact tool.
        // Gated BEFORE the assistant tool-call row is persisted (below) and
        // BEFORE the retry-budget counter is touched — an approval pause is
        // not a tool "attempt".
        //
        // OPERATOR TURNS USE `operatorPolicyFor` INSTEAD, NOT AS WELL. The two
        // are not stacked, and dropping `sensitivityFor` here loses nothing:
        // the only tools it can ever return non-'safe' for are manage_app,
        // manage_repo, manage_schema, manage_billing and manage_migrations, and
        // every one of those is absent from OPERATOR_TOOL_ALLOWLIST — so the
        // operator's verdict for all five is already 'deny', which is strictly
        // stronger than 'pause for approval'. `sensitivityFor` also encodes the
        // assistant's premise, that a human is watching every call and its
        // tiers are a UX affordance; that premise is exactly what is false
        // headless. `checkTrust` is likewise NOT consulted for the operator:
        // there is one conversation per org forever, so conversation-wide trust
        // would be permanent org-wide auto-approval.
        const sensitivity = isOperator ? 'safe' : sensitivityFor(tc.name, tc.args);
        if (operatorVerdict === 'approval') {
          const messageId = randomUUID();
          const approval = await createApproval(input.pool, {
            conversationId: input.conversationId,
            turnMessageId: messageId,
            toolName: tc.name,
            toolArgs: tc.args,
            // The operator feed has one tier. 'destructive' is the tier the
            // operator approval-resolution path (tool-bridge/resume) already
            // expects, and there is no weaker meaning available.
            sensitivity: 'destructive',
            traceId: input.traceId ?? null,
          });
          // `gated`: the operator turn stops here, right now, and does not
          // resume until a human resolves `approval.id` — reported via
          // `logOperatorCheckpoint('resumed', ...)` in operator-turn.ts on
          // whichever later wake finds the gate cleared. Tool NAME only,
          // never `tc.args` — see the no-tool-args rule in this checkpoint's
          // module doc comment.
          if (input.traceId) {
            logOperatorCheckpoint('gated', {
              traceId: input.traceId,
              conversationId: input.conversationId,
              approvalId: approval.id,
              toolName: tc.name,
            });
          }
          await appendMessage(
            input.pool,
            input.conversationId,
            {
              role: 'assistant',
              content: i === 0 ? assistantText : '',
              toolCallId: tc.id,
              toolName: tc.name,
              toolArgs: tc.args,
              toolResult: null,
              modelUsed: input.model,
              pendingApprovalId: approval.id,
            },
            messageId,
          );
          yield {
            type: 'approval_required',
            approval_id: approval.id,
            tool_name: tc.name,
            args: tc.args,
            sensitivity: 'destructive',
          };
          terminated = true;
          break outer;
        }
        if (sensitivity !== 'safe') {
          const trusted = await checkTrust(input.pool, input.conversationId, tc.name);
          if (!trusted) {
            const messageId = randomUUID();
            const approval = await createApproval(input.pool, {
              conversationId: input.conversationId,
              turnMessageId: messageId,
              toolName: tc.name,
              toolArgs: tc.args,
              sensitivity,
            });
            await appendMessage(
              input.pool,
              input.conversationId,
              {
                role: 'assistant',
                content: i === 0 ? assistantText : '',
                toolCallId: tc.id,
                toolName: tc.name,
                toolArgs: tc.args,
                toolResult: null,
                modelUsed: input.model,
                pendingApprovalId: approval.id,
              },
              messageId,
            );
            yield {
              type: 'approval_required',
              approval_id: approval.id,
              tool_name: tc.name,
              args: tc.args,
              sensitivity,
            };
            terminated = true;
            break outer;
          }
        }

        const assistantRow = await appendMessage(input.pool, input.conversationId, {
          role: 'assistant',
          content: i === 0 ? assistantText : '',
          toolCallId: tc.id,
          toolName: tc.name,
          toolArgs: tc.args,
          toolResult: null,
          modelUsed: input.model,
        });

        yield { type: 'tool_call', ...tc };

        // Retry budget guard (Task 5): detect the agent calling the same tool
        // with the same args over and over and give up rather than spin forever.
        {
          const argsHash = hashToolArgs(tc.args);
          const prior = retryState.get(tc.name);
          if (prior && prior.lastArgsHash === argsHash) {
            prior.retries += 1;
          } else {
            retryState.set(tc.name, { lastArgsHash: argsHash, retries: 0 });
          }
          const state = retryState.get(tc.name)!;

          if (state.retries >= TOOL_RETRY_LIMIT) {
            const stuckMessage = `Agent stuck on ${tc.name} — same args tried 3 times. Ask the user how to proceed.`;
            yield { type: 'error', message: stuckMessage };
            const summary = `I got stuck repeating the same "${tc.name}" call with identical arguments and stopped after ${TOOL_RETRY_LIMIT} attempts. Let me know how you'd like to proceed.`;
            lastAssistantText = summary;
            await appendMessage(input.pool, input.conversationId, {
              role: 'assistant',
              content: summary,
              toolCallId: null,
              toolName: null,
              toolArgs: null,
              toolResult: null,
              modelUsed: input.model,
            });
            yield { type: 'assistant_message', content: summary };
            terminated = true;
            break outer;
          }
        }

        /**
         * THE CONTROL, part 2: operator policy deny.
         *
         * Deliberately placed AHEAD of the catalog allowlist guard and ahead of
         * EVERY route below (file-op, deploy, deploy_function, MCP), so there is
         * no dispatch path an operator can reach without passing through it.
         * Nothing between the verdict's computation above and this point calls a
         * tool — only message persistence, the tool_call event and the retry
         * counter.
         *
         * It does not depend on the catalog: `operatorPolicyFor` denies anything
         * not on OPERATOR_TOOL_ALLOWLIST, so a name the model invented, or one
         * that was filtered out of the catalog, is refused here just the same.
         * That is why the catalog filter is only an affordance.
         *
         * The refusal is returned as a TOOL RESULT, not thrown: the model sees
         * an ordinary tool error, can adapt, and the conversation history keeps
         * its assistant-tool_call → tool-result pairing (a history ending in an
         * unanswered tool_call is rejected by the gateway and would wedge the
         * org's one operator conversation permanently).
         */
        if (operatorVerdict === 'deny') {
          const errorMsg = `Tool "${tc.name}" is not permitted for the autonomous operator.`;
          const resultPayload = { error: errorMsg };
          toolCallResults.push({ id: tc.id, ...resultPayload });
          yield { type: 'tool_result', id: tc.id, ...resultPayload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: { error: errorMsg },
          });
          continue;
        }

        // Allowlist guard
        if (!allowedToolNames.has(tc.name)) {
          const errorMsg = `Tool "${tc.name}" is not available in this agent's catalog.`;
          const resultPayload = { error: errorMsg };
          toolCallResults.push({ id: tc.id, ...resultPayload });
          yield { type: 'tool_result', id: tc.id, ...resultPayload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: { error: errorMsg },
          });
          continue;
        }

        /**
         * ---- Route: operator scratchpad (in-process) ---------------------
         *
         * The agent's own working memory. Dispatched here rather than through
         * MCP because there is no such MCP tool and no reason to invent one:
         * the row lives in the control plane, which this process already owns
         * a pool for.
         *
         * THE ORG IS NOT AN ARGUMENT. It is `operatorOrgId`, derived from the
         * `operator:<org>` sentinel that `operator-turn.ts` hardcodes from the
         * claimed job — the same trusted source the cross-org guard compares
         * against. There is no model-supplied field that can redirect this
         * write, so one org can never write another's scratchpad. (A stray
         * `org_id` argument would additionally have been denied upstream by
         * `operatorPolicyForOrg`; that is belt to this braces, not the reason
         * this is safe.)
         *
         * The `isOperator` re-check is defence in depth: the tool is filtered
         * out of the human catalog and would be refused by the allowlist guard
         * above, but a route that writes operator state should not depend on
         * a filter two hundred lines away for its precondition.
         *
         * Oversized content is REJECTED as an ordinary tool error, never
         * truncated — see OPERATOR_SCRATCHPAD_MAX_CHARS. The model sees the
         * failure and can shorten its own summary; silent truncation would
         * drop whichever part did not fit with no signal.
         */
        if (isOperatorScratchpadTool(tc.name)) {
          toolCallsCount++;
          const spArgs = (tc.args ?? {}) as { content?: unknown };
          let payload: { result?: unknown; error?: string };
          if (!isOperator || !operatorOrgId) {
            payload = { error: `Tool "${tc.name}" is only available to the autonomous operator.` };
          } else if (typeof spArgs.content !== 'string') {
            payload = { error: `Tool "${tc.name}" requires a string "content" argument.` };
          } else {
            try {
              const saved = await setOperatorScratchpad(input.pool, operatorOrgId, spArgs.content);
              payload = {
                result: { ok: true, characters: saved.content.length, updated_at: saved.updatedAt },
              };
            } catch (err) {
              payload = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          toolCallResults.push({ id: tc.id, ...payload });
          yield { type: 'tool_result', id: tc.id, ...payload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: payload.error !== undefined ? { error: payload.error } : payload.result,
          });
          continue;
        }

        /**
         * ---- Route: sandbox code execution (in-process) -------------------
         *
         * Dispatched here, never forwarded to MCP: there is no MCP tool by
         * this name, and the whole point of `codeExecutor` is that it runs
         * OUTSIDE this process, in an isolated MicroVM `SandboxRunner` already
         * created for this turn.
         *
         * THE RULE: no `codeExecutor` means no execution, ever — not "execute
         * on the host instead". Reaching this branch with `input.codeExecutor`
         * missing should be IMPOSSIBLE: the tool was dropped from `tools`
         * above whenever `codeExecutor` was absent, so it is also absent from
         * `allowedToolNames`, and the allowlist guard a few lines up already
         * refused it. The `typeof input.codeExecutor !== 'function'` branch
         * below is defence in depth for exactly the reason the scratchpad
         * route re-checks `isOperator`: a route that can execute code must not
         * depend on a filter two hundred lines away for its only proof of
         * safety. If this branch is ever reached, refuse — do NOT fall back to
         * running `rcArgs.code` in this process.
         *
         * The `isOperator` check is the same defence-in-depth as the
         * scratchpad route: the tool is filtered out of the human catalog and
         * would be refused by the allowlist guard above regardless.
         */
        if (isRunSandboxCodeTool(tc.name)) {
          toolCallsCount++;
          const rcArgs = (tc.args ?? {}) as { code?: unknown };
          let payload: { result?: unknown; error?: string };
          if (!isOperator) {
            payload = { error: `Tool "${tc.name}" is only available to the autonomous operator.` };
          } else if (typeof input.codeExecutor !== 'function') {
            payload = { error: `Tool "${tc.name}" is not available: no sandbox executor for this turn.` };
          } else if (typeof rcArgs.code !== 'string') {
            payload = { error: `Tool "${tc.name}" requires a string "code" argument.` };
          } else {
            try {
              const r = await input.codeExecutor(rcArgs.code);
              payload = { result: r };
            } catch (err) {
              payload = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          toolCallResults.push({ id: tc.id, ...payload });
          yield { type: 'tool_result', id: tc.id, ...payload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: payload.error !== undefined ? { error: payload.error } : payload.result,
          });
          continue;
        }

        // ---- Route: file-op tools (in-process) ----------------------------
        if (isFileOpTool(tc.name)) {
          const args = (tc.args ?? {}) as { app_id?: string };
          toolCallsCount++;
          if (args.app_id && (tc.name === 'write_file' || tc.name === 'delete_file')) {
            touchedApps.add(args.app_id);
          }
          const r = await fileOps.execute(tc.name as FileOpName, args, {
            convId: input.conversationId,
            jwt: input.jwt,
          });
          // Drain any file_change / active_app_change events emitted during exec.
          for (const evt of drainPending()) yield evt;

          const payload: { result?: unknown; error?: string } = r.ok
            ? { result: r.data }
            : { error: r.error };
          if (r.ok && tc.name === 'write_file') fileWritesCount++;
          toolCallResults.push({ id: tc.id, ...payload });
          yield { type: 'tool_result', id: tc.id, ...payload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: r.ok ? r.data : { error: r.error },
          });
          continue;
        }

        // ---- Route: deploy tool (in-process) ------------------------------
        if (isDeployTool(tc.name)) {
          const args = (tc.args ?? {}) as { app_id?: string };
          toolCallsCount++;
          if (!args.app_id) {
            const err = 'app_id is required';
            toolCallResults.push({ id: tc.id, error: err });
            yield { type: 'tool_result', id: tc.id, error: err };
            await appendMessage(input.pool, input.conversationId, {
              role: 'tool',
              content: '',
              toolCallId: tc.id,
              toolName: tc.name,
              toolArgs: tc.args,
              toolResult: { error: err },
            });
            continue;
          }
          // Ensure the workspace is hydrated before bundling.
          try {
            await ensureHydrated({ convId: input.conversationId, appId: args.app_id, jwt: input.jwt });
          } catch {
            // Fall through — deployer will report "no files" if truly empty.
          }
          touchedApps.add(args.app_id);
          const r = await deployer.deploy({
            convId: input.conversationId,
            appId: args.app_id,
            jwt: input.jwt,
          });
          for (const evt of drainPending()) yield evt;
          const payload: { result?: unknown; error?: string } = r.ok
            ? { result: { deployment_id: r.deployment_id, url: r.url } }
            : { error: r.error };
          if (r.ok) deploymentsCount++;
          toolCallResults.push({ id: tc.id, ...payload });
          yield { type: 'tool_result', id: tc.id, ...payload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: payload.error ? { error: payload.error } : (payload.result ?? {}),
          });
          continue;
        }

        // ---- Route: deploy_function_from_workspace tool (in-process) -----
        if (isDeployFunctionTool(tc.name)) {
          const args = (tc.args ?? {}) as {
            app_id?: string;
            function_name?: string;
            trigger?: { type: 'http' | 'cron' | 's3_upload' | 'webhook' | 'websocket'; config?: unknown };
            envVars?: Record<string, string>;
            timeoutMs?: number;
            memoryLimitMb?: number;
          };
          toolCallsCount++;
          if (!args.app_id || !args.function_name) {
            const err = 'app_id and function_name are required';
            toolCallResults.push({ id: tc.id, error: err });
            yield { type: 'tool_result', id: tc.id, error: err };
            await appendMessage(input.pool, input.conversationId, {
              role: 'tool',
              content: '',
              toolCallId: tc.id,
              toolName: tc.name,
              toolArgs: tc.args,
              toolResult: { error: err },
            });
            continue;
          }
          try {
            await ensureHydrated({ convId: input.conversationId, appId: args.app_id, jwt: input.jwt });
          } catch {
            // Fall through — deployer will report "entry file not found" if truly empty.
          }
          touchedApps.add(args.app_id);
          const r = await functionDeployer.deploy({
            convId: input.conversationId,
            appId: args.app_id,
            jwt: input.jwt,
            functionName: args.function_name,
            trigger: args.trigger,
            envVars: args.envVars,
            timeoutMs: args.timeoutMs,
            memoryLimitMb: args.memoryLimitMb,
          });
          for (const evt of drainPending()) yield evt;
          const payload: { result?: unknown; error?: string } = r.ok
            ? { result: { url: r.url, deployment_id: r.deploymentId } }
            : { error: r.error };
          toolCallResults.push({ id: tc.id, ...payload });
          yield { type: 'tool_result', id: tc.id, ...payload };
          await appendMessage(input.pool, input.conversationId, {
            role: 'tool',
            content: '',
            toolCallId: tc.id,
            toolName: tc.name,
            toolArgs: tc.args,
            toolResult: payload.error ? { error: payload.error } : (payload.result ?? {}),
          });
          continue;
        }

        // ---- Default: MCP tool -------------------------------------------
        toolCallsCount++;
        // `acted`: the first tool call this turn actually reaches an MCP
        // dispatch (as opposed to being denied/refused above, which is not
        // "acting"). Once per turn — see `actedLogged`'s declaration.
        if (isOperator && input.traceId && !actedLogged) {
          actedLogged = true;
          logOperatorCheckpoint('acted', {
            traceId: input.traceId,
            conversationId: input.conversationId,
            toolName: tc.name,
          });
        }
        const call = await callMcpTool(
          tc.name, tc.args, input.jwt, input.organizationId, input.traceId, input.triggerContext,
        );
        // Scope app discovery to the active org. The shared `/apps` endpoint
        // deliberately fans out across every org the user belongs to; here —
        // and only on the dashboard-agent path — we narrow `manage_app` list
        // results to the org the user is currently working in so the model
        // isn't shown apps from unrelated orgs. Best-effort: any parse miss
        // leaves the result untouched.
        if (
          call.ok &&
          tc.name === 'manage_app' &&
          (tc.args as { action?: string } | null)?.action === 'list' &&
          input.organizationId
        ) {
          call.result = scopeAppListToOrg(call.result, input.organizationId);
        }

        /**
         * FIX E — SUBSTRATE-ESCALATED APPROVAL, raised AFTER dispatch.
         *
         * `operatorPolicyFor` pauses a propose BEFORE dispatch only for the
         * eight capabilities on the static `default_policy: 'approval_required'`
         * mirror. That mirror is documented as the FLOOR, not the ceiling:
         * substrate's policy engine ALSO escalates at propose time — a principle
         * conflict returns requires_approval even on an 'auto' capability, per
         * org, dynamically. Those calls legitimately get verdict 'allow' and
         * dispatch, and substrate correctly holds the line: nothing executes,
         * the action parks in `proposed`.
         *
         * What was missing is only visibility. No dashboard approval existed, so
         * the action sat in substrate's ledger where the operator feed cannot
         * see it, and the operator's own way out (`manage_substrate approve`) is
         * correctly denied to it. The work stalled silently and every subsequent
         * wake burned a cycle rediscovering it.
         *
         * NOT a second gate and NOT a widening of the static mirror — conflicts
         * are dynamic and per-org, and predicting them is the wrong shape. This
         * reacts to what substrate actually answered.
         *
         * The approval stores the APPROVE of that action id, never the propose:
         * the propose has already happened, so resolution must call
         * `approve(action_id)` only and must never re-propose. Everything about
         * what may be stored is enforced inside
         * `createSubstrateEscalationApproval` — read its header before changing
         * anything here; the action id comes from `readSubstrateEscalation`,
         * i.e. from SUBSTRATE'S RESPONSE, never from `tc.args`.
         *
         * Operator-only (`isOperator`), so the human assistant is untouched.
         *
         * Deliberately NO `role:'tool'` row is written for the propose here.
         * The turn pauses in exactly the same shape the pre-dispatch gate uses —
         * assistant tool_call row + `pending_approval_id`, answered later by
         * `completeApprovalResolution` — which is what keeps the resolution path,
         * and the wedge fix it carries, identical for both approval kinds.
         *
         * If the atomic create returns null (the row was already marked, or is
         * not a pausable assistant row) we fall through and record the pending
         * propose as an ordinary tool result: today's behaviour, never a
         * half-paused turn.
         */
        if (isOperator && call.ok) {
          const escalatedActionId = readSubstrateEscalation(tc.name, tc.args, call.result);
          if (escalatedActionId) {
            const approval = await createSubstrateEscalationApproval(input.pool, {
              conversationId: input.conversationId,
              pausedMessageId: assistantRow.id,
              actionId: escalatedActionId,
              traceId: input.traceId ?? null,
            });
            if (approval) {
              if (input.traceId) {
                logOperatorCheckpoint('gated', {
                  traceId: input.traceId,
                  conversationId: input.conversationId,
                  approvalId: approval.id,
                  toolName: tc.name,
                  escalated: true,
                });
              }
              yield {
                type: 'approval_required',
                approval_id: approval.id,
                tool_name: tc.name,
                args: tc.args,
                sensitivity: 'destructive',
              };
              terminated = true;
              break outer;
            }
          }
        }

        const resultPayload = call.ok ? { result: call.result } : { error: call.error };
        toolCallResults.push({ id: tc.id, ...resultPayload });
        yield { type: 'tool_result', id: tc.id, ...resultPayload };
        await appendMessage(input.pool, input.conversationId, {
          role: 'tool',
          content: '',
          toolCallId: tc.id,
          toolName: tc.name,
          toolArgs: tc.args,
          toolResult: call.ok ? call.result : { error: call.error },
        });
      }

      messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: pendingToolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        })),
      });
      for (let i = 0; i < pendingToolCalls.length; i++) {
        const tc = pendingToolCalls[i];
        const res = toolCallResults[i];
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(res.error !== undefined ? { error: res.error } : res.result),
        });
      }
    }

    // Reached the tool call cap
    if (!terminated) {
      yield { type: 'error', message: `Tool call limit reached (${TOOL_CALL_LIMIT}).` };
    }
  } catch (err: unknown) {
    // Tool invocation threw an uncaught exception.
    // Emit error frame and proceed to end-of-turn cleanup.
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message };
  } finally {
    // End-of-turn: flush touched apps + record usage (guaranteed to run)
    for (const appId of touchedApps) {
      const baseline = baselineByApp.get(appId) ?? new Map<string, string>();
      try {
        const flushResult = await repoSync.flush({
          convId: input.conversationId,
          appId,
          jwt: input.jwt,
          baseline,
        });

        // Task 5 (Plan 3d): auto-name the new snapshot. Entirely best-effort —
        // must never block or fail the SSE stream, so every step is wrapped.
        if (flushResult.newSnapshotId) {
          try {
            const gateway = snapshotTitleGatewayFactory(input.jwt);
            const snapshotTitle = await deriveSnapshotTitle(
              input.userMessage,
              lastAssistantText,
              gateway,
              turnNumber,
            );
            await upsertSnapshotLabelFn(input.pool, {
              conversationId: input.conversationId,
              appId,
              snapshotId: flushResult.newSnapshotId,
              label: snapshotTitle,
              autoGenerated: true,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn(`[dashboard-agent] snapshot auto-naming failed for app ${appId}: ${message}`);
          }
        }
      } catch (err: unknown) {
        // Best-effort; loop should not hard-fail because of a flush error —
        // but DO log it so silent persistence failures don't leave the user
        // wondering why files vanish on refresh.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dashboard-agent] end-of-turn flush failed for app ${appId}: ${message}`);
      }
    }

    try {
      await recordUsage(input.pool, {
        userId: input.userId,
        conversationId: input.conversationId,
        model: input.model,
        promptTokens: gatewayPromptTokens,
        completionTokens: gatewayCompletionTokens,
        toolCallsCount,
        fileWritesCount,
        deploymentsCount,
      });
    } catch {
      // Telemetry is best-effort in v1.
    }

    // Task 2 (Plan 3e): auto-title the conversation after its first assistant
    // turn. Entirely best-effort — never blocks or fails the SSE stream, and
    // never overwrites a title the user (or a prior turn) already set.
    if (lastAssistantText) {
      try {
        const conversation = await getConversationFn(input.pool, input.conversationId, input.userId);
        if (conversation && conversation.title === 'New conversation') {
          const gateway = snapshotTitleGatewayFactory(input.jwt);
          const title = await generateConversationTitle(input.userMessage, lastAssistantText, gateway);
          if (title) {
            const updated = await updateConversationTitleFn(
              input.pool,
              input.conversationId,
              input.userId,
              title,
            );
            if (updated) {
              yield { type: 'title_updated', title: updated.title };
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[dashboard-agent] conversation auto-titling failed: ${message}`);
      }
    }
  }
}
