import type { ResponsesRequest } from './responses-schema.js';
import type { ChatCompletionRequest } from './schemas.js';
import { toReasoningEffort, type Reasoning } from './reasoning.js';

export const BUILTIN_TOOL_TYPES = ['web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview'] as const;

/**
 * Chat Completions has no notion of a tool namespace, so `type: "namespace"`
 * tools (what the Codex CLI sends for MCP servers) are flattened to
 * `<namespace>__<tool>` on the way in. This map remembers the way back:
 * flattened name -> the namespace plus the tool's own name. It must be threaded
 * explicitly rather than re-derived by splitting on `__`, because namespace
 * names themselves contain `__` (e.g. `mcp__butterbase`) and the split is
 * therefore ambiguous.
 */
export type NamespaceToolMap = Map<string, { namespace: string; name: string }>;

export function flattenNamespacedToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

type CCMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

/**
 * Map a Responses `function_call` item back to the flattened chat-completions
 * tool name. Prefers the item's own `namespace` field (what we emit, and what
 * clients echo back); falls back to a unique reverse lookup in the map for
 * clients that drop the field.
 */
function flattenCallName(it: Record<string, unknown>, ns: NamespaceToolMap | undefined): string {
  const name = String(it.name);
  if (typeof it.namespace === 'string' && it.namespace.length > 0) {
    return flattenNamespacedToolName(it.namespace, name);
  }
  if (!ns) return name;
  if (ns.has(name)) return name;
  const matches = [...ns.entries()].filter(([, v]) => v.name === name);
  return matches.length === 1 ? matches[0][0] : name;
}

function itemsToMessages(items: unknown[], ns?: NamespaceToolMap): CCMessage[] {
  const out: CCMessage[] = [];
  for (const it of items as Array<Record<string, unknown>>) {
    // priorInput rows are stored as raw CC user messages (no `type` field); priorOutput rows are Responses items. Accept both.
    if (it.type === 'message' || (it.type === undefined && it.role !== undefined)) {
      const role = (it.role === 'developer' ? 'system' : it.role) as CCMessage['role'];
      const c = it.content;
      let text: string;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) text = c.map((b: any) => b.text).filter(Boolean).join('\n');
      else text = '';
      out.push({ role, content: text });
    } else if (it.type === 'function_call') {
      out.push({
        role: 'assistant', content: null,
        tool_calls: [{ id: String(it.call_id), type: 'function',
                       function: { name: flattenCallName(it, ns), arguments: String(it.arguments) } }],
      });
    } else if (it.type === 'function_call_output') {
      out.push({ role: 'tool', tool_call_id: String(it.call_id), content: String(it.output) });
    }
  }
  return out;
}

export function responsesRequestToChatCompletion(
  req: ResponsesRequest,
  priorInput: unknown[] | null,
  priorOutput: unknown[] | null,
  reasoning: Reasoning | null,
  /** Optional out-param: populated with the flattened -> namespaced tool mapping. */
  namespaceTools?: NamespaceToolMap,
): ChatCompletionRequest {
  // Tools are resolved first: the namespace mapping they produce is needed to
  // re-flatten `function_call` items replayed in the conversation history.
  const tools = req.tools?.flatMap((t) => {
    if (t.type === 'function') {
      return [{
        type: 'function' as const,
        function: { name: t.name!, description: t.description ?? '', parameters: t.parameters ?? {} },
      }];
    }
    if (t.type === 'namespace') {
      const nested = (t as { tools?: Array<Record<string, unknown>> }).tools ?? [];
      const namespace = t.name ?? '';
      return nested
        .filter((n) => n.type === 'function' && typeof n.name === 'string')
        .map((n) => {
          const inner = String(n.name);
          const flat = flattenNamespacedToolName(namespace, inner);
          namespaceTools?.set(flat, { namespace, name: inner });
          return {
            type: 'function' as const,
            function: {
              name: flat,
              description: typeof n.description === 'string' ? n.description : '',
              parameters: (n.parameters as Record<string, unknown> | undefined) ?? {},
            },
          };
        });
    }
    // Built-in tool types (and anything else unknown) are dropped; the caller
    // is responsible for rejecting them up front.
    return [];
  });

  const messages: CCMessage[] = [];
  if (req.instructions) messages.push({ role: 'system', content: req.instructions });
  if (priorInput) messages.push(...itemsToMessages(priorInput, namespaceTools));
  if (priorOutput) messages.push(...itemsToMessages(priorOutput, namespaceTools));
  if (typeof req.input === 'string') messages.push({ role: 'user', content: req.input });
  else messages.push(...itemsToMessages(req.input, namespaceTools));

  const cc: Record<string, unknown> = {
    model: req.model, messages,
    max_tokens: req.max_output_tokens,
    temperature: req.temperature, top_p: req.top_p,
    stream: req.stream, tools,
    tool_choice: req.tool_choice,
  };
  const r = reasoning ?? (req.reasoning?.effort ? { enabled: true, effort: req.reasoning.effort, budgetTokens: 0 } as Reasoning : null);
  if (r?.enabled) cc.reasoning_effort = toReasoningEffort(r);
  return cc as ChatCompletionRequest;
}

export interface ResponsesResponseBody {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'failed';
  model: string;
  previous_response_id: string | null;
  output: Array<{
    type: 'message';
    id: string;
    role: 'assistant';
    content: Array<{ type: 'output_text'; text: string }>;
  } | {
    type: 'function_call';
    /** Item id. Optional: the non-streaming path does not mint one. */
    id?: string;
    call_id: string; name: string;
    /** Present only for tools that arrived inside a `type: "namespace"` group. */
    namespace?: string;
    arguments: string;
  }>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; reasoning_tokens?: number };
}

type CCResponse = {
  id: string;
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

export function chatCompletionResponseToResponses(args: {
  id: string; model: string; createdAt: number; previousResponseId: string | null; cc: CCResponse;
  namespaceTools?: NamespaceToolMap;
}): ResponsesResponseBody {
  const ch = args.cc.choices[0];
  const output: ResponsesResponseBody['output'] = [];
  if (ch.message.content != null) {
    output.push({
      type: 'message', id: `msg_${args.id.slice(4, 12)}`, role: 'assistant',
      content: [{ type: 'output_text', text: ch.message.content }],
    });
  }
  for (const tc of ch.message.tool_calls ?? []) {
    output.push(namespacedFunctionCall(tc.id, tc.function.name, tc.function.arguments, args.namespaceTools));
  }
  const u = args.cc.usage;
  const usage: ResponsesResponseBody['usage'] = {
    input_tokens: u.prompt_tokens,
    output_tokens: u.completion_tokens,
    total_tokens: u.prompt_tokens + u.completion_tokens,
  };
  const reasoningTokens = u.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoningTokens === 'number') usage.reasoning_tokens = reasoningTokens;
  return {
    id: args.id, object: 'response', created_at: args.createdAt, status: 'completed',
    model: args.model, previous_response_id: args.previousResponseId,
    output, usage,
  };
}

/**
 * Build a Responses `function_call` item, splitting a flattened name back into
 * separate `name` + `namespace` fields when it came from a namespace group.
 * Codex rejects a flattened, bare, or dotted single name (`unsupported call`);
 * only the two-field shape routes correctly.
 */
export function namespacedFunctionCall(
  callId: string,
  flatName: string,
  argumentsJson: string,
  ns?: NamespaceToolMap,
): { type: 'function_call'; call_id: string; name: string; namespace?: string; arguments: string } {
  const hit = ns?.get(flatName);
  return hit
    ? { type: 'function_call', call_id: callId, name: hit.name, namespace: hit.namespace, arguments: argumentsJson }
    : { type: 'function_call', call_id: callId, name: flatName, arguments: argumentsJson };
}
