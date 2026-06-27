import type { ResponsesRequest } from './responses-schema.js';
import type { ChatCompletionRequest } from './schemas.js';
import { toReasoningEffort, type Reasoning } from './reasoning.js';

export const BUILTIN_TOOL_TYPES = ['web_search_preview', 'file_search', 'code_interpreter', 'computer_use_preview'] as const;

type CCMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
};

function itemsToMessages(items: unknown[]): CCMessage[] {
  const out: CCMessage[] = [];
  for (const it of items as Array<Record<string, unknown>>) {
    if (it.type === 'message' || (it.type === undefined && it.role !== undefined)) {
      // Handles both Responses message items ({ type: 'message', role, content })
      // and raw chat-completions messages ({ role, content }) stored as priorInput.
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
                       function: { name: String(it.name), arguments: String(it.arguments) } }],
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
): ChatCompletionRequest {
  const messages: CCMessage[] = [];
  if (req.instructions) messages.push({ role: 'system', content: req.instructions });
  if (priorInput) messages.push(...itemsToMessages(priorInput));
  if (priorOutput) messages.push(...itemsToMessages(priorOutput));
  if (typeof req.input === 'string') messages.push({ role: 'user', content: req.input });
  else messages.push(...itemsToMessages(req.input));

  const tools = req.tools?.filter(t => t.type === 'function').map(t => ({
    type: 'function' as const,
    function: { name: t.name!, description: t.description ?? '', parameters: t.parameters ?? {} },
  }));

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
    call_id: string; name: string; arguments: string;
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
}): ResponsesResponseBody {
  const ch = args.cc.choices[0];
  const output: ResponsesResponseBody['output'] = [];
  if (ch.message.content) {
    output.push({
      type: 'message', id: `msg_${args.id.slice(4, 12)}`, role: 'assistant',
      content: [{ type: 'output_text', text: ch.message.content }],
    });
  }
  for (const tc of ch.message.tool_calls ?? []) {
    output.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
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
