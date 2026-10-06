import type { MessagesRequest } from './messages-schema.js';
import type { ChatCompletionRequest } from './schemas.js';
import { toReasoningEffort, type Reasoning } from './reasoning.js';

export class UnsupportedTranslationError extends Error {
  constructor(public readonly detail: string) {
    super(`Unsupported translation: ${detail}`);
    this.name = 'UnsupportedTranslationError';
  }
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type CCMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * Anthropic image block -> chat-completions `image_url` part. Both source
 * shapes collapse to a URL: `url` sources pass through, `base64` sources
 * become a data URI. Returns null for a shape we can't turn into a URL, so
 * callers can decide between dropping and erroring.
 */
function imageBlockToPart(block: Record<string, unknown>): ContentPart | null {
  const src = block.source as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object') return null;
  if (src.type === 'url' && typeof src.url === 'string') {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  if (src.type === 'base64' && typeof src.data === 'string') {
    const mediaType = typeof src.media_type === 'string' ? src.media_type : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${src.data}` } };
  }
  return null;
}

/** Collapse a part list to a bare string when it is a single text part. */
function partsToContent(parts: ContentPart[]): string | ContentPart[] {
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

/**
 * Split tool_result content into the text the `tool` message carries and any
 * images it produced. Chat-completions `tool` messages take a string only, so
 * images are handed back for the caller to re-emit as a following user turn —
 * that keeps screenshot-style tool output visible to the model instead of
 * failing the request.
 */
function splitToolResultContent(content: unknown): { text: string; images: ContentPart[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  if (Array.isArray(content)) {
    const texts: string[] = [];
    const images: ContentPart[] = [];
    for (const b of content) {
      if (typeof b !== 'object' || b === null) {
        throw new UnsupportedTranslationError('unrecognized block in tool_result content');
      }
      const block = b as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      } else if (block.type === 'image') {
        const part = imageBlockToPart(block);
        if (part) images.push(part);
      }
      // Any other block type (document, search results, future additions) is
      // dropped rather than fatal — a partial tool result beats a 400.
    }
    return { text: texts.join('\n'), images };
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
      // tool_result blocks must be emitted first: chat-completions requires the
      // `tool` messages to directly follow the assistant message that made the
      // calls, whereas Anthropic clients are free to order blocks either way.
      const parts: ContentPart[] = [];
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        const { text, images } = splitToolResultContent(b.content);
        messages.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: text || (images.length ? '[see image in the following message]' : ''),
        });
        parts.push(...images);
      }
      for (const b of m.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if ((b as { type: string }).type === 'image') {
          const part = imageBlockToPart(b as unknown as Record<string, unknown>);
          if (part) parts.push(part);
        }
      }
      if (parts.length) messages.push({ role: 'user', content: partsToContent(parts) });
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
