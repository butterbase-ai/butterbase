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
import { getToolCatalog, isFileOpTool, isDeployTool, isDeployFunctionTool, sensitivityFor, type ToolSpec } from './tool-catalog.js';
import { callMcpTool } from './mcp-client.js';
import { createApproval, checkTrust } from './approvals-store.js';
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
  | { type: 'error'; message: string }
  | { type: 'file_change'; app_id: string; path: string; kind: 'write' | 'delete'; content?: string; sha256?: string }
  | { type: 'active_app_change'; app_id: string; app_name?: string }
  | { type: 'deployment_progress'; deployment_id: string; status: 'queued' | 'building' | 'live' | 'failed'; url?: string; log_tail?: string; error?: string }
  | { type: 'function_deployment_progress'; function_name: string; status: 'queued' | 'uploading' | 'live' | 'failed'; url?: string; error?: string }
  | { type: 'approval_required'; approval_id: string; tool_name: string; args: unknown; sensitivity: 'confirm' | 'destructive' }
  | { type: 'title_updated'; title: string };

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
    throw new Error(`gateway ${res.status}`);
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

export async function* runAgentTurn(
  input: {
    conversationId: string;
    userId: string;
    jwt: string;
    userMessage: string;
    model: string;
    pool: pg.Pool;
  },
  depsOverride?: Partial<LoopDeps>,
): AsyncGenerator<LoopEvent> {
  const base = getDefaultDeps();
  const deps: LoopDeps = { ...base, ...(depsOverride ?? {}) };
  const { cache, repoSync, recordUsage, loadTemplate } = deps;
  const snapshotTitleGatewayFactory = deps.snapshotTitleGatewayFactory ?? createGatewayChat;
  const upsertSnapshotLabelFn = deps.upsertSnapshotLabel ?? upsertSnapshotLabel;
  const getConversationFn = deps.getConversation ?? getConversation;
  const updateConversationTitleFn = deps.updateConversationTitle ?? updateConversationTitle;

  // 1. Persist the user turn
  await appendMessage(input.pool, input.conversationId, {
    role: 'user',
    content: input.userMessage,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    toolResult: null,
  });

  const tools = getToolCatalog();

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
        mcp: deps.mcp,
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
              const result = await deps.mcp.call(name, args, jwt);
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
      const schemasByAppId = await fetchAppSchemasCached(recentAppIds, input.jwt, deps.mcp, schemaCache);
      schemaPromptBlock = buildSchemaPromptBlock(schemasByAppId);
    }
  } catch {
    // Schema injection is best-effort — never block the turn on it.
  }

  const messages: GatewayMessage[] = [
    { role: 'system', content: schemaPromptBlock + getSystemPrompt() },
    ...toGatewayMessages(history),
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
        yield { type: 'error', message };
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

        // Sensitivity gate (Plan 3b Task 2): destructive/confirm-tier calls
        // pause the turn for explicit user approval, unless the conversation
        // has already granted conversation-wide trust for this exact tool.
        // Gated BEFORE the assistant tool-call row is persisted (below) and
        // BEFORE the retry-budget counter is touched — an approval pause is
        // not a tool "attempt".
        const sensitivity = sensitivityFor(tc.name, tc.args);
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

        await appendMessage(input.pool, input.conversationId, {
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
        const call = await callMcpTool(tc.name, tc.args, input.jwt);
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
