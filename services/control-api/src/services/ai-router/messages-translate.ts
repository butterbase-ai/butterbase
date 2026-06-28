import type { MessagesRequest } from './messages-schema.js';
import type { ChatCompletionRequest } from './schemas.js';
import { toReasoningEffort, type Reasoning } from './reasoning.js';

export class UnsupportedTranslationError extends Error {
  constructor(public readonly detail: string) {
    super(`Unsupported translation: ${detail}`);
    this.name = 'UnsupportedTranslationError';
  }
}

type CCMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

function blockContentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const b of content) {
      if (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text') texts.push((b as { text: string }).text);
      else throw new UnsupportedTranslationError('non-text block in tool_result content');
    }
    return texts.join('\n');
  }
  throw new UnsupportedTranslationError('unrecognized tool_result content');
}

export function messagesRequestToChatCompletion(req: MessagesRequest, reasoning: Reasoning | null): ChatCompletionRequest {
  const messages: CCMessage[] = [];
  if (req.system) {
    const sys = typeof req.system === 'string' ? req.system : req.system.map(b => b.text).join('\n');
    messages.push({ role: 'system', content: sys });
  }
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const texts: string[] = [];
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      for (const b of m.content) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'tool_use') toolCalls.push({
          id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
        else if (b.type === 'thinking') { /* drop — not representable in chat-completions */ }
      }
      messages.push({
        role: 'assistant',
        content: texts.length ? texts.join('\n') : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const b of m.content) {
        if (b.type === 'text') messages.push({ role: 'user', content: b.text });
        else if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: blockContentToString(b.content) });
        }
      }
    }
  }

  const tools = req.tools?.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description ?? '', parameters: t.input_schema },
  }));

  let toolChoice: unknown;
  if (req.tool_choice) {
    if (req.tool_choice.type === 'auto') toolChoice = 'auto';
    else if (req.tool_choice.type === 'any') toolChoice = 'required';
    else if (req.tool_choice.type === 'tool') toolChoice = { type: 'function', function: { name: req.tool_choice.name } };
  }

  const cc: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    stop: req.stop_sequences,
    tools, tool_choice: toolChoice,
  };
  if (reasoning?.enabled) cc.reasoning_effort = toReasoningEffort(reasoning);
  return cc as ChatCompletionRequest;
}

type CCResponse = {
  id: string;
  choices: Array<{
    message: { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> };
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
};

export interface MessagesResponseBody {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>;
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence';
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export function chatCompletionResponseToMessages(model: string, body: CCResponse): MessagesResponseBody {
  const choice = body.choices[0];
  const content: MessagesResponseBody['content'] = [];
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
  for (const tc of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = { _raw: tc.function.arguments }; }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
  }
  const stop_reason = ({
    stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use',
    content_filter: 'stop_sequence', function_call: 'tool_use',
  } as const)[choice.finish_reason];
  return {
    id: body.id, type: 'message', role: 'assistant', model, content,
    stop_reason, stop_sequence: null,
    usage: { input_tokens: body.usage.prompt_tokens, output_tokens: body.usage.completion_tokens },
  };
}
