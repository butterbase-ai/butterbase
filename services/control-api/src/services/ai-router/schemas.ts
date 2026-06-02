import { z } from 'zod';

/**
 * OpenAI Chat Completions content-part schema. Covers the common parts we
 * understand (text, image_url, video_url) and leaves room for emerging part
 * types via a passthrough fallback so the validator doesn't reject new
 * upstream-supported modalities the moment OpenAI ships them.
 */
export const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }),
  }),
  z.object({ type: z.literal('video_url'), video_url: z.object({ url: z.string() }) }),
  z.object({ type: z.string() }).passthrough(),
]);

/**
 * An OpenAI-style function tool call as it appears on an assistant message.
 * `arguments` is a JSON string (not an object) — that matches the OpenAI wire
 * format, and upstream providers (OpenRouter, OpenAI) expect a string here.
 */
export const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export type ContentPart = z.infer<typeof contentPartSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;

/**
 * OpenAI Chat Completions message schema, discriminated by role.
 *
 * Spec notes baked into the rules below:
 * - assistant.content may be null when, and only when, the message carries
 *   one or more tool_calls (enforced via superRefine).
 * - tool messages must reference the call they answer via tool_call_id.
 * - The legacy `function` role is preserved for back-compat with older
 *   client code; it is deprecated and new code should use `tool`.
 *
 * Per-variant fields are explicit (no .passthrough()) because unknown
 * fields on assistant messages are a prompt-injection vector for
 * provider-specific extensions. Top-level request-body extensions
 * (e.g. OpenRouter's `provider`) flow through the outer passthrough on
 * chatCompletionRequestSchema (added in a later task).
 */
const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]),
  name: z.string().optional(),
  refusal: z.string().nullable().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  tool_call_id: z.string(),
});

const functionMessageSchema = z.object({
  role: z.literal('function'),
  name: z.string(),
  content: z.union([z.string(), z.null()]),
});

export const messageSchema = z
  .discriminatedUnion('role', [
    systemMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
    functionMessageSchema,
  ])
  .superRefine((msg, ctx) => {
    if (msg.role === 'assistant' && msg.content === null) {
      const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
      if (!hasToolCalls) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['content'],
          message:
            'assistant.content may only be null when tool_calls is a non-empty array',
        });
      }
    }
  });

export type Message = z.infer<typeof messageSchema>;
