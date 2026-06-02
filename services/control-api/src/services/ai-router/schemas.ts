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
