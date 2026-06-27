import type { ResponsesRequest } from './responses-schema.js';
import type { RouteContext } from './router.js';
import { routeChatCompletion } from './router.js';
import {
  responsesRequestToChatCompletion,
  chatCompletionResponseToResponses,
  BUILTIN_TOOL_TYPES,
  type ResponsesResponseBody,
} from './responses-translate.js';
import { parseReasoningFromBody } from './reasoning.js';
import {
  loadResponseRow,
  insertResponseRow,
  generateResponseId,
  DEFAULT_TTL_SECONDS,
} from './responses-store.js';
import { translateCcStreamToResponsesSse } from './responses-sse.js';

export interface RouteResponsesResult {
  status: number;
  body?: ResponsesResponseBody | unknown;
  stream?: ReadableStream<Uint8Array>;
  chosen?: string;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

export async function routeResponses(
  ctx: RouteContext,
  req: ResponsesRequest,
): Promise<RouteResponsesResult> {
  const built = req.tools?.find((t) =>
    (BUILTIN_TOOL_TYPES as readonly string[]).includes(t.type),
  );
  if (built) {
    return {
      status: 400,
      body: {
        error: {
          type: 'invalid_request_error',
          code: 'unsupported_tool',
          message: `Built-in tool '${built.type}' is not yet supported. See follow-up spec.`,
        },
      },
    };
  }

  let priorInput: unknown[] | null = null;
  let priorOutput: unknown[] | null = null;
  if (req.previous_response_id) {
    const row = await loadResponseRow(ctx.runtimePool, req.previous_response_id);
    if (!row) {
      return {
        status: 404,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'response_not_found',
            message: `previous_response_id ${req.previous_response_id} not found`,
          },
        },
      };
    }
    priorInput = Array.isArray(row.inputMessages) ? (row.inputMessages as unknown[]) : null;
    priorOutput = Array.isArray(row.output) ? (row.output as unknown[]) : null;
  }

  const reasoning = parseReasoningFromBody(req as unknown as Record<string, unknown>);
  const ccReq = responsesRequestToChatCompletion(req, priorInput, priorOutput, reasoning);
  const id = generateResponseId();
  const createdAt = nowSeconds();

  if (req.stream) {
    const cc = await routeChatCompletion(ctx, { ...(ccReq as any), stream: true });
    if (!cc.stream) return { status: cc.status, body: cc.body, chosen: cc.chosen };
    const sse = translateCcStreamToResponsesSse({
      id,
      model: req.model,
      createdAt,
      ccStream: cc.stream,
      onClose: async (finalBody) => {
        await insertResponseRow(ctx.runtimePool, {
          id,
          createdAt,
          previousResponseId: req.previous_response_id ?? null,
          model: req.model,
          inputMessages:
            typeof req.input === 'string'
              ? [{ type: 'message', role: 'user', content: req.input }]
              : req.input,
          output: finalBody.output,
          usage: finalBody.usage,
          status: 'completed',
          expiresAt: createdAt + DEFAULT_TTL_SECONDS,
        });
      },
    });
    return { status: 200, stream: sse, chosen: cc.chosen };
  }

  const cc = await routeChatCompletion(ctx, ccReq as any);
  if (cc.status >= 400 || !cc.body) {
    return { status: cc.status, body: cc.body, chosen: cc.chosen };
  }
  const body = chatCompletionResponseToResponses({
    id,
    model: req.model,
    createdAt,
    previousResponseId: req.previous_response_id ?? null,
    cc: cc.body as any,
  });
  await insertResponseRow(ctx.runtimePool, {
    id,
    createdAt,
    previousResponseId: req.previous_response_id ?? null,
    model: req.model,
    inputMessages:
      typeof req.input === 'string'
        ? [{ type: 'message', role: 'user', content: req.input }]
        : req.input,
    output: body.output,
    usage: body.usage,
    status: 'completed',
    expiresAt: createdAt + DEFAULT_TTL_SECONDS,
  });
  return { status: 200, body, chosen: cc.chosen };
}
