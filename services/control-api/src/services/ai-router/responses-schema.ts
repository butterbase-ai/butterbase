import { z } from 'zod';

const inputContent = z.array(z.union([
  z.object({ type: z.literal('input_text'), text: z.string() }).passthrough(),
  z.object({ type: z.literal('output_text'), text: z.string() }).passthrough(),
]));

const messageItem = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'system', 'developer']),
  content: z.union([z.string(), inputContent]),
}).passthrough();

const fnCall = z.object({
  type: z.literal('function_call'),
  call_id: z.string(), name: z.string(), arguments: z.string(),
}).passthrough();

const fnCallOut = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(), output: z.string(),
}).passthrough();

const inputItem = z.discriminatedUnion('type', [messageItem, fnCall, fnCallOut]);

const tool = z.object({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
}).passthrough();

export const responsesRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(inputItem)]),
  instructions: z.string().optional(),
  previous_response_id: z.string().optional(),
  reasoning: z.object({ effort: z.enum(['low', 'medium', 'high']).optional() }).optional(),
  tools: z.array(tool).optional(),
  tool_choice: z.union([z.literal('auto'), z.literal('required'), z.literal('none'),
    z.object({ type: z.literal('function'), name: z.string() })]).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_output_tokens: z.number().int().optional(),
  stream: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
