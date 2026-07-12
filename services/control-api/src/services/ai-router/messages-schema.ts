import { z } from 'zod';

const textBlock = z.object({ type: z.literal('text'), text: z.string() }).passthrough();
const toolUseBlock = z.object({
  type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.unknown()),
}).passthrough();
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.union([textBlock, z.object({ type: z.literal('image') }).passthrough()]))]),
  is_error: z.boolean().optional(),
}).passthrough();
const thinkingBlock = z.object({ type: z.literal('thinking'), thinking: z.string() }).passthrough();

const contentBlock = z.discriminatedUnion('type', [textBlock, toolUseBlock, toolResultBlock, thinkingBlock]);

const message = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlock)]),
});

const toolDecl = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.unknown()),
}).passthrough();

const toolChoice = z.union([
  z.object({ type: z.literal('auto') }).passthrough(),
  z.object({ type: z.literal('any') }).passthrough(),
  z.object({ type: z.literal('tool'), name: z.string() }).passthrough(),
]);

export const messagesRequestSchema = z.object({
  model: z.string(),
  max_tokens: z.number().int().positive(),
  messages: z.array(message).min(1),
  system: z.union([z.string(), z.array(textBlock)]).optional(),
  metadata: z.record(z.unknown()).optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().optional(),
  tools: z.array(toolDecl).optional(),
  tool_choice: toolChoice.optional(),
  thinking: z.object({
    type: z.literal('enabled'),
    budget_tokens: z.number().int().nonnegative(),
  }).optional(),
}).passthrough();

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

/**
 * Structural guard for the minimum shape /v1/messages needs for its own bookkeeping
 * (routing, lease sizing, token estimation, sync-vs-stream branching). Everything
 * else is passthrough to the upstream provider — Anthropic validates its own API.
 * See messages-schema.ts changelog for rationale.
 */
export function guardMessagesRoutingShape(
  raw: unknown,
): { ok: true; body: MessagesRequest } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Request body must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  if (typeof b.model !== 'string' || b.model.length === 0) {
    return { ok: false, message: 'Field "model" must be a non-empty string' };
  }
  if (typeof b.max_tokens !== 'number' || !Number.isFinite(b.max_tokens) || b.max_tokens <= 0) {
    return { ok: false, message: 'Field "max_tokens" must be a positive number' };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, message: 'Field "messages" must be a non-empty array' };
  }
  if (b.stream !== undefined && typeof b.stream !== 'boolean') {
    return { ok: false, message: 'Field "stream" must be boolean when present' };
  }
  return { ok: true, body: b as MessagesRequest };
}
