import type { MessagesRequest } from './messages-schema.js';
import type { RouteContext } from './router.js';
import { routeChatCompletion } from './router.js';
import {
  messagesRequestToChatCompletion,
  chatCompletionResponseToMessages,
  UnsupportedTranslationError,
  type MessagesResponseBody,
} from './messages-translate.js';
import { parseReasoningFromBody, stripThinkingSuffix } from './reasoning.js';
import { readCatalogEntry } from './catalog.js';
import { rankRoutersForModel } from './select.js';
import { translateCcStreamToMessagesSse } from './messages-sse.js';

export interface RouteMessagesResult {
  status: number;
  body?: MessagesResponseBody | unknown;
  stream?: ReadableStream<Uint8Array>;
  chosen?: string;
}

export interface MessagesHeaders {
  anthropicVersion?: string;
  anthropicBeta?: string;
}

async function pickFirstNativeAdapter(ctx: RouteContext, canonicalId: string) {
  const entry = await readCatalogEntry(ctx.redis, canonicalId);
  if (!entry) return null;
  const ranked = rankRoutersForModel(entry, new Set(Array.from(ctx.adapters.keys())));
  for (const r of ranked) {
    const adapter = ctx.adapters.get(r.name);
    if (adapter?.capabilities?.supportsNativeMessages(canonicalId)) return { adapter, router: r };
  }
  return null;
}

export async function routeMessages(
  ctx: RouteContext,
  req: MessagesRequest,
  _headers: MessagesHeaders,
): Promise<RouteMessagesResult> {
  const { model: stripped, usedSuffix } = stripThinkingSuffix(req.model);
  const reasoning = parseReasoningFromBody(req as unknown as Record<string, unknown>);
  const normalized: MessagesRequest = { ...req, model: stripped };

  // Native passthrough path. When an adapter supports the Anthropic Messages
  // API natively, skip the chat-completions translation layer and forward the
  // request body directly. Streaming native path forwards upstream bytes as-is
  // (no translation) — Anthropic event shape is already correct.
  const native = await pickFirstNativeAdapter(ctx, stripped);
  if (native && native.adapter.nativeMessages) {
    const upstreamId = native.router.upstreamId ?? native.adapter.toUpstreamId(stripped);
    if (req.stream) {
      const result = await native.adapter.nativeMessages(
        { ...normalized, stream: true },
        upstreamId,
        _headers,
      );
      return { status: result.status, stream: result.stream, chosen: native.adapter.name };
    }
    const result = await native.adapter.nativeMessages(normalized, upstreamId, _headers);
    return { status: result.status, body: result.body, chosen: native.adapter.name };
  }
  void usedSuffix;

  let ccReq;
  try {
    ccReq = messagesRequestToChatCompletion(normalized, reasoning);
  } catch (e) {
    if (e instanceof UnsupportedTranslationError) {
      return { status: 400, body: {
        type: 'error', error: { type: 'unsupported_translation', message: e.detail },
      } };
    }
    throw e;
  }

  if (req.stream) {
    // Translation streaming: ask the chat-completions router for an SSE stream
    // and re-emit it in Anthropic's event shape.
    const cc = await routeChatCompletion(ctx, { ...(ccReq as any), stream: true });
    if (!cc.stream) {
      return { status: cc.status, body: cc.body, chosen: cc.chosen };
    }
    return {
      status: 200,
      stream: translateCcStreamToMessagesSse(stripped, cc.stream),
      chosen: cc.chosen,
    };
  }

  const cc = await routeChatCompletion(ctx, ccReq as any);
  if (cc.status >= 400 || !cc.body) return { status: cc.status, body: cc.body, chosen: cc.chosen };
  const body = chatCompletionResponseToMessages(stripped, cc.body as any);
  return { status: 200, body, chosen: cc.chosen };
}
