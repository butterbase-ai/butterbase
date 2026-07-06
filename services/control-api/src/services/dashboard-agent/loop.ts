/**
 * Agent loop for the Butterbase Dashboard Assistant.
 *
 * runAgentTurn:  user turn → stream tokens → tool calls → tool results → repeat
 * streamChatCompletion: wraps the AI gateway's /v1/chat/completions SSE endpoint.
 *
 * Gateway notes (from gateway.ts investigation):
 *   - Endpoint: POST /v1/chat/completions  (platform-level, no per-app URL segment)
 *   - Auth: Bearer JWT in Authorization header
 *   - appId: null — gateway resolves organization from the userId in the JWT
 *   - Payload: OpenAI-compatible (messages, tools, tool_choice, stream:true)
 *   - Response: OpenAI SSE delta format; tool_calls index-based, args split across chunks
 *
 * Task-4 concern: the calling URL (AI_GATEWAY_URL env) must be set in the HTTP
 * route. In local dev, default is http://localhost:3000 (the control-api itself).
 */

import pg from 'pg';
import { appendMessage, listMessages, type Message } from './store.js';
import { getToolCatalog, type ToolSpec } from './tool-catalog.js';
import { callMcpTool } from './mcp-client.js';
import { getSystemPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LoopEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; result?: unknown; error?: string }
  | { type: 'assistant_message'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown };

interface GatewayMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert persisted store messages to the gateway's OpenAI-compatible format.
 */
function toGatewayMessages(messages: Message[]): GatewayMessage[] {
  return messages.map((msg): GatewayMessage => {
    // Tool-result row — maps to OpenAI 'tool' role
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId ?? '',
        content: JSON.stringify(msg.toolResult ?? {}),
      };
    }
    // Assistant turn that issued a tool call
    if (msg.role === 'assistant' && msg.toolCallId) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: [
          {
            id: msg.toolCallId,
            type: 'function',
            function: {
              name: msg.toolName ?? '',
              arguments: JSON.stringify(msg.toolArgs ?? {}),
            },
          },
        ],
      };
    }
    // Plain user / assistant / system message
    return { role: msg.role, content: msg.content };
  });
}

/**
 * Stream chat completions from the AI gateway.
 * Yields token chunks and fully-assembled tool_call chunks.
 */
export async function* streamChatCompletion(opts: {
  model: string;
  messages: GatewayMessage[];
  tools: ToolSpec[];
  jwt: string;
}): AsyncGenerator<StreamChunk> {
  const url = `${process.env.AI_GATEWAY_URL ?? 'http://localhost:3000'}/v1/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.jwt}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: 'auto',
      stream: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`gateway ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Accumulate tool_calls[index] across chunks before yielding
  const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
  let sawToolCallsFinish = false;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by double newlines
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break outer;

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;

        // Text token
        if (delta?.content) {
          yield { type: 'token', text: delta.content };
        }

        // Tool call fragment — accumulate by index
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: '', name: '', args: '' });
            }
            const acc = toolCallAccum.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
          }
        }

        // Emit completed tool calls when finish_reason signals done
        if (choice.finish_reason === 'tool_calls') {
          sawToolCallsFinish = true;
          for (const [, acc] of toolCallAccum) {
            let parsedArgs: unknown;
            try {
              parsedArgs = JSON.parse(acc.args);
            } catch {
              parsedArgs = {};
            }
            yield { type: 'tool_call', id: acc.id, name: acc.name, args: parsedArgs };
          }
          toolCallAccum.clear();
        }
      }
    }
  }

  // Safety flush: emit any accumulated tool calls if [DONE] arrived without
  // a tool_calls finish_reason (some gateway implementations behave this way)
  if (!sawToolCallsFinish && toolCallAccum.size > 0) {
    for (const [, acc] of toolCallAccum) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(acc.args);
      } catch {
        parsedArgs = {};
      }
      yield { type: 'tool_call', id: acc.id, name: acc.name, args: parsedArgs };
    }
  }
}

// ---------------------------------------------------------------------------
// Main export: runAgentTurn
// ---------------------------------------------------------------------------

const TOOL_CALL_LIMIT = 8;

export async function* runAgentTurn(input: {
  conversationId: string;
  userId: string;
  jwt: string;
  userMessage: string;
  model: string;
  pool: pg.Pool;
}): AsyncGenerator<LoopEvent> {
  // 1. Persist the user turn
  await appendMessage(input.pool, input.conversationId, {
    role: 'user',
    content: input.userMessage,
    toolCallId: null,
    toolName: null,
    toolArgs: null,
    toolResult: null,
  });

  const tools = getToolCatalog();

  // Load history after persisting the user message so it is included
  const history = await listMessages(input.pool, input.conversationId);
  const messages: GatewayMessage[] = [
    { role: 'system', content: getSystemPrompt() },
    ...toGatewayMessages(history),
  ];

  // 2. Agentic loop — cap at TOOL_CALL_LIMIT steps
  for (let step = 0; step < TOOL_CALL_LIMIT; step++) {
    let assistantText = '';
    let pendingToolCall: { id: string; name: string; args: unknown } | null = null;

    const stream = streamChatCompletion({
      model: input.model,
      messages,
      tools,
      jwt: input.jwt,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'token') {
        assistantText += chunk.text;
        yield { type: 'token', text: chunk.text };
      } else if (chunk.type === 'tool_call') {
        // Keep only the last tool call emitted in this stream pass
        pendingToolCall = chunk;
      }
    }

    // No tool call — assistant is done
    if (!pendingToolCall) {
      await appendMessage(input.pool, input.conversationId, {
        role: 'assistant',
        content: assistantText,
        toolCallId: null,
        toolName: null,
        toolArgs: null,
        toolResult: null,
      });
      yield { type: 'assistant_message', content: assistantText };
      yield { type: 'done' };
      return;
    }

    // Persist the assistant's tool-calling message
    await appendMessage(input.pool, input.conversationId, {
      role: 'assistant',
      content: assistantText,
      toolCallId: pendingToolCall.id,
      toolName: pendingToolCall.name,
      toolArgs: pendingToolCall.args,
      toolResult: null,
    });
    yield { type: 'tool_call', ...pendingToolCall };

    // Execute the tool via MCP
    const call = await callMcpTool(pendingToolCall.name, pendingToolCall.args, input.jwt);
    yield {
      type: 'tool_result',
      id: pendingToolCall.id,
      ...(call.ok ? { result: call.result } : { error: call.error }),
    };

    // Persist the tool result row
    await appendMessage(input.pool, input.conversationId, {
      role: 'tool',
      content: '',
      toolCallId: pendingToolCall.id,
      toolName: pendingToolCall.name,
      toolArgs: pendingToolCall.args,
      toolResult: call.ok ? call.result : { error: call.error },
    });

    // Append to in-memory message history for next gateway call
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: [
        {
          id: pendingToolCall.id,
          type: 'function',
          function: {
            name: pendingToolCall.name,
            arguments: JSON.stringify(pendingToolCall.args),
          },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: pendingToolCall.id,
      content: JSON.stringify(call.ok ? call.result : { error: call.error }),
    });
  }

  // Reached the tool call cap
  yield { type: 'error', message: 'Tool call limit reached (8).' };
}
