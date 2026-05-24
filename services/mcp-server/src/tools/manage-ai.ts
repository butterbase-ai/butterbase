import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPut } from '../api-client.js';

export function registerManageAi(server: McpServer) {
  server.tool(
    'manage_ai',
    `Use the app's AI gateway: chat, embeddings, list models, read/update config, read usage.

Actions:
  - chat              { app_id, messages, model?, temperature?, max_tokens? }
                       Synchronous (no streaming). Returns the full assistant response.
                       Default model is the app's configured default, or "openai/gpt-4o-mini".
  - embed             { app_id, input (string | string[]), model?, encoding_format? }
                       Returns OpenAI-shaped embedding response.
  - list_models       { app_id }
                       Returns { models: AiModel[] } — discover what the app can call.
  - get_config        { app_id }
                       Returns { defaultModel, allowedModels, maxTokensPerRequest, ... }
  - update_config     { app_id, config }
                       Set defaultModel, allowedModels, maxTokensPerRequest (1–100000), or rotate BYOK.
  - get_usage         { app_id, startDate?, endDate? }
                       Aggregate token counts and costs over a window.
  - submit_video      { app_id, model, prompt, duration?, resolution?, aspect_ratio?, generate_audio?, seed? }
                       Submits an async video-generation job. Returns { job_id, status, polling_url }.
                       Poll the returned URL until status is "completed".
  - poll_video        { app_id, job_id }
                       Returns current { status, model, content_urls?, error?, created_at }.
                       When status is "completed", content_urls contains absolute URLs (same origin
                       as the polling_url) that the caller can fetch() directly using the same
                       Authorization header. Use this to drive your own polling loop.

This tool wraps the same /v1/:app_id/chat/completions, /embeddings, /ai/config, /ai/models,
/ai/usage routes the SDK uses. The "chat" action sets stream: false; for streamed deltas,
drive the SDK from inside a function or DO.`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum([
        'chat', 'embed', 'list_models', 'get_config', 'update_config', 'get_usage',
        'submit_video', 'poll_video',
      ]).describe('The action to perform'),
      // chat
      messages: z.array(z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.union([z.string(), z.array(z.any())]),
        name: z.string().optional(),
        tool_call_id: z.string().optional(),
      })).optional().describe('Required for chat'),
      model: z.string().optional(),
      temperature: z.number().optional(),
      max_tokens: z.number().int().positive().optional(),
      // embed
      input: z.union([z.string(), z.array(z.string())]).optional().describe('Required for embed'),
      encoding_format: z.enum(['float', 'base64']).optional(),
      // update_config
      config: z.object({
        defaultModel: z.string().optional(),
        byokKey: z.string().optional(),
        maxTokensPerRequest: z.number().int().min(1).max(100_000).optional(),
        allowedModels: z.array(z.string()).optional(),
      }).optional().describe('Required for update_config'),
      // get_usage
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      // submit_video
      prompt: z.string().optional().describe('Required for submit_video'),
      duration: z.number().int().positive().optional(),
      resolution: z.string().optional(),
      aspect_ratio: z.string().optional(),
      generate_audio: z.boolean().optional(),
      seed: z.number().int().optional(),
      // poll_video
      job_id: z.string().optional().describe('Required for poll_video'),
    },
    {
      title: 'Manage AI',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      try {
        const { app_id, action } = args;
        let result: unknown;
        switch (action) {
          case 'chat': {
            if (!args.messages) {
              return { content: [{ type: 'text' as const, text: 'Error: "messages" is required for "chat".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/chat/completions`, {
              messages: args.messages,
              model: args.model,
              temperature: args.temperature,
              max_tokens: args.max_tokens,
              stream: false,
            });
            break;
          }
          case 'embed': {
            if (args.input === undefined) {
              return { content: [{ type: 'text' as const, text: 'Error: "input" is required for "embed".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/embeddings`, {
              input: args.input,
              model: args.model,
              encoding_format: args.encoding_format,
            });
            break;
          }
          case 'list_models': {
            result = await apiGet(`/v1/${app_id}/ai/models`);
            break;
          }
          case 'get_config': {
            result = await apiGet(`/v1/${app_id}/ai/config`);
            break;
          }
          case 'update_config': {
            if (!args.config) {
              return { content: [{ type: 'text' as const, text: 'Error: "config" is required for "update_config".' }], isError: true as const };
            }
            result = await apiPut(`/v1/${app_id}/ai/config`, args.config);
            break;
          }
          case 'get_usage': {
            const q = new URLSearchParams();
            if (args.startDate) q.set('startDate', args.startDate);
            if (args.endDate) q.set('endDate', args.endDate);
            const qs = q.toString();
            result = await apiGet(`/v1/${app_id}/ai/usage${qs ? `?${qs}` : ''}`);
            break;
          }
          case 'submit_video': {
            if (!args.prompt) {
              return { content: [{ type: 'text' as const, text: 'Error: "prompt" is required for "submit_video".' }], isError: true as const };
            }
            if (!args.model) {
              return { content: [{ type: 'text' as const, text: 'Error: "model" is required for "submit_video".' }], isError: true as const };
            }
            result = await apiPost(`/v1/${app_id}/videos/completions`, {
              model: args.model,
              prompt: args.prompt,
              duration: args.duration,
              resolution: args.resolution,
              aspect_ratio: args.aspect_ratio,
              generate_audio: args.generate_audio,
              seed: args.seed,
            });
            break;
          }
          case 'poll_video': {
            if (!args.job_id) {
              return { content: [{ type: 'text' as const, text: 'Error: "job_id" is required for "poll_video".' }], isError: true as const };
            }
            result = await apiGet(`/v1/${app_id}/videos/completions/${encodeURIComponent(args.job_id)}`);
            break;
          }

        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };
      }
    },
  );
}
