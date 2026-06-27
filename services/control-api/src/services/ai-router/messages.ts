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

  // Native passthrough path — deferred to Task 6. For Task 5 we always
  // translate; Task 6 swaps in the native branch before the translation.
  void pickFirstNativeAdapter; void usedSuffix;

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
    // Streaming translation lives in Task 7; non-streaming Task 5
    // returns 501 explicitly so a half-shipped state is loud.
    return { status: 501, body: {
      type: 'error', error: { type: 'not_implemented', message: 'streaming pending Task 7' },
    } };
  }

  const cc = await routeChatCompletion(ctx, ccReq as any);
  if (cc.status >= 400 || !cc.body) return { status: cc.status, body: cc.body, chosen: cc.chosen };
  const body = chatCompletionResponseToMessages(stripped, cc.body as any);
  return { status: 200, body, chosen: cc.chosen };
}
