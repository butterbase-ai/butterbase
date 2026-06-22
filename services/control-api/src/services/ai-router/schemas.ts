import { z } from 'zod';

export const cacheControlSchema = z.object({
  type: z.literal('ephemeral'),
  ttl: z.enum(['5m', '1h']).optional(),
});

/**
 * OpenAI Chat Completions content-part schema. Covers the common parts we
 * understand (text, image_url, video_url) and leaves room for emerging part
 * types via a passthrough fallback so the validator doesn't reject new
 * upstream-supported modalities the moment OpenAI ships them.
 */
export const contentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string(), cache_control: cacheControlSchema.optional() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string(), detail: z.string().optional() }),
    cache_control: cacheControlSchema.optional(),
  }),
  z.object({ type: z.literal('video_url'), video_url: z.object({ url: z.string() }), cache_control: cacheControlSchema.optional() }),
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
  cache_control: cacheControlSchema.optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  name: z.string().optional(),
  cache_control: cacheControlSchema.optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]),
  name: z.string().optional(),
  refusal: z.string().nullable().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
  cache_control: cacheControlSchema.optional(),
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([z.string(), z.array(contentPartSchema)]),
  tool_call_id: z.string(),
  cache_control: cacheControlSchema.optional(),
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

/** OpenAI tool/function declaration (request side, not the call). */
const toolDeclarationSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.literal('auto'),
  z.literal('none'),
  z.literal('required'),
  z.object({
    type: z.literal('function'),
    function: z.object({ name: z.string() }),
  }),
]);

const responseFormatSchema = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string(),
      schema: z.record(z.unknown()),
      strict: z.boolean().optional(),
      description: z.string().optional(),
    }),
  }),
]);

/**
 * Top-level chat completions request schema.
 *
 * Outer `.passthrough()` is intentional: it lets provider-specific extensions
 * such as OpenRouter's `provider` field survive into the upstream call. The
 * OpenAI surface is enumerated explicitly so each known field is type-checked
 * and inferred; only genuinely unknown top-level keys ride the passthrough.
 */
export const chatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(messageSchema),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .passthrough()
      .optional(),
    max_tokens: z.number().int().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().min(1).optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    logit_bias: z.record(z.number()).optional(),
    user: z.string().optional(),
    seed: z.number().int().optional(),
    response_format: responseFormatSchema.optional(),
    tools: z.array(toolDeclarationSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    parallel_tool_calls: z.boolean().optional(),
    cache_control: cacheControlSchema.optional(),
    session_id: z.string().max(256).optional(),
  })
  .passthrough();

export const embeddingRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(z.string())]),
  encoding_format: z.enum(['float', 'base64']).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
