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
