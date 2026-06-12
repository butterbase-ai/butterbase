import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from '../api-client.js';

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
  - start_meeting     { app_id, meeting_url, transcript?, recording?, metadata?, bot_name? }
                       Spawn a meeting bot that joins a Zoom/Meet/Teams/Webex call.
                       recording: "mp4" (default), "audio_only", or false. transcript defaults to true.
                       bot_name (1–64 chars) sets the display name attendees see; defaults to "Butterbase Notetaker".
                       Returns { id, status, botName, ... }. Save id to call get_meeting / stop_meeting later.
  - get_meeting       { app_id, meeting_id }
                       Current status + recordingUrl / transcriptUrl (populated when artifacts are ready).
  - list_meetings     { app_id, status?, limit?, cursor? }
                       Page through this app's bots. status filters to a lifecycle phase
                       (joining / waiting_room / in_call / recording / ended / done / fatal).
  - stop_meeting      { app_id, meeting_id }
                       Force the bot to leave the call. Returns 204 / no body on success.
  - estimate_meeting  { app_id, duration_minutes, transcript? }
                       Predict the USD charge for a hypothetical session at this duration.
  - configure_meetings_webhook  { app_id, forward_url, rotate_secret? }
                       Upsert the app's meetings webhook forward URL.
                       When rotate_secret is true (or no row exists), generates a new signing secret
                       (wsec_…) and returns it once — store it immediately. The secret is the
                       HMAC-SHA256 key that signs every forwarded event for THIS app — see the
                       "meetings" topic in butterbase_docs for verification details.
                       Returns { ok, app_id, forward_url, secret } where secret is null when not rotated.
  - usage_meetings    { app_id }
                       Returns the last 100 rows from actor_usage_logs for the app.
                       Each row has { id, dimension, seconds, usd_charged, created_at }.

This tool wraps the same /v1/:app_id/chat/completions, /embeddings, /ai/config, /ai/models,
/ai/usage routes the SDK uses. The "chat" action sets stream: false; for streamed deltas,
drive the SDK from inside a function or DO.`,
    {
      app_id: z.string().describe('The app ID'),
      action: z.enum([
        'chat', 'embed', 'list_models', 'get_config', 'update_config', 'get_usage',
        'submit_video', 'poll_video',
        'start_meeting', 'get_meeting', 'list_meetings', 'stop_meeting', 'estimate_meeting',
        'configure_meetings_webhook', 'usage_meetings',
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
      // configure_meetings_webhook
      forward_url: z.string().optional().describe('Required for configure_meetings_webhook'),
      rotate_secret: z.boolean().optional().describe('For configure_meetings_webhook — generate a new signing secret'),
      // start_meeting / list_meetings / etc.
      meeting_url: z.string().optional().describe('Required for start_meeting'),
      meeting_id: z.string().optional().describe('Required for get_meeting / stop_meeting'),
      transcript: z.coerce.boolean().optional().describe('For start_meeting / estimate_meeting (default true)'),
      recording: z.union([z.literal('mp4'), z.literal('audio_only'), z.literal('false'), z.literal(false)]).optional()
        .describe('For start_meeting: "mp4" (default), "audio_only", or false to skip recording'),
      metadata: z.record(z.string()).optional()
        .describe('For start_meeting — arbitrary string→string map; keys may not start with bb_'),
      bot_name: z.string().min(1).max(64).optional()
        .describe('For start_meeting — display name the bot uses when it joins (1–64 chars). Defaults to "Butterbase Notetaker".'),
      status: z.enum(['joining','waiting_room','in_call','recording','ended','done','fatal']).optional()
        .describe('For list_meetings — filter to one lifecycle phase'),
      limit: z.coerce.number().int().min(1).max(100).optional().describe('For list_meetings (default 20)'),
      cursor: z.string().optional().describe('For list_meetings pagination'),
      duration_minutes: z.coerce.number().int().min(1).max(24 * 60).optional()
        .describe('Required for estimate_meeting'),
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
          case 'start_meeting': {
            if (!args.meeting_url) {
              return { content: [{ type: 'text' as const, text: 'Error: "meeting_url" is required for "start_meeting".' }], isError: true as const };
            }
            const recording = args.recording === 'false' ? false : (args.recording ?? 'mp4');
            result = await apiPost(`/v1/${app_id}/ai/meetings`, {
              meetingUrl: args.meeting_url,
              transcript: args.transcript ?? true,
              recording,
              metadata: args.metadata,
              botName: args.bot_name,
            });
            break;
          }
          case 'get_meeting': {
            if (!args.meeting_id) {
              return { content: [{ type: 'text' as const, text: 'Error: "meeting_id" is required for "get_meeting".' }], isError: true as const };
            }
            result = await apiGet(`/v1/${app_id}/ai/meetings/${encodeURIComponent(args.meeting_id)}`);
            break;
          }
          case 'list_meetings': {
            const q = new URLSearchParams();
            if (args.status) q.set('status', args.status);
            if (args.limit !== undefined) q.set('limit', String(args.limit));
            if (args.cursor) q.set('cursor', args.cursor);
            const qs = q.toString();
            result = await apiGet(`/v1/${app_id}/ai/meetings${qs ? `?${qs}` : ''}`);
            break;
          }
          case 'stop_meeting': {
            if (!args.meeting_id) {
              return { content: [{ type: 'text' as const, text: 'Error: "meeting_id" is required for "stop_meeting".' }], isError: true as const };
            }
            result = await apiDelete(`/v1/${app_id}/ai/meetings/${encodeURIComponent(args.meeting_id)}`);
            break;
          }
          case 'estimate_meeting': {
            if (args.duration_minutes === undefined) {
              return { content: [{ type: 'text' as const, text: 'Error: "duration_minutes" is required for "estimate_meeting".' }], isError: true as const };
            }
            const q = new URLSearchParams();
            q.set('durationMinutes', String(args.duration_minutes));
            if (args.transcript !== undefined) q.set('transcript', String(args.transcript));
            result = await apiGet(`/v1/${app_id}/ai/meetings/_estimate?${q.toString()}`);
            break;
          }
          case 'configure_meetings_webhook': {
            if (!args.forward_url) {
              return { content: [{ type: 'text' as const, text: 'Error: "forward_url" is required for "configure_meetings_webhook".' }], isError: true as const };
            }
            result = await apiPut(`/v1/${app_id}/ai/meetings/webhook`, {
              forward_url: args.forward_url,
              rotate_secret: args.rotate_secret,
            });
            break;
          }
          case 'usage_meetings': {
            result = await apiGet(`/v1/${app_id}/ai/meetings/usage`);
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
