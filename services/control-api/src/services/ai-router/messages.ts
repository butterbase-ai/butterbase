import type { MessagesRequest } from './messages-schema.js';
import type { RouteContext } from './router.js';
import { routeChatCompletion, acquireWithAudit, maybeFireCreditsEmail } from './router.js';
import {
  messagesRequestToChatCompletion,
  chatCompletionResponseToMessages,
  UnsupportedTranslationError,
  type MessagesResponseBody,
} from './messages-translate.js';
import { parseReasoningFromBody, stripThinkingSuffix } from './reasoning.js';
import { readCatalogEntry } from './catalog.js';
import { rankRoutersForModel, estimateWorstCaseUsd } from './select.js';
import { translateCcStreamToMessagesSse } from './messages-sse.js';
import type { AdapterUsage } from './adapters/types.js';
import { estimatePromptTokens } from './tokenizer.js';
import { settleAfterCall, leaseTtlSeconds } from './billing-gate.js';
import type { LeaseHandle } from './billing-gate.js';
import { writeAiUsageRow } from './usage-log.js';
import { applyMarkup } from './markup.js';
import { maybeTriggerAutoRefill } from '../auto-refill-service.js';

export interface RouteMessagesResult {
  status: number;
  body?: MessagesResponseBody | unknown;
  stream?: ReadableStream<Uint8Array>;
  chosen?: string;
  /** Usage reported by the adapter; null for streaming (unavailable until stream end). */
  usage?: AdapterUsage | null;
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

function wrapNativeAnthropicStreamForSettlement(
  upstream: ReadableStream<Uint8Array>,
  lease: LeaseHandle,
  pricing: { promptPricePerMtok: number; completionPricePerMtok: number },
  ctx: RouteContext,
  canonicalId: string,
  chosenRouter: string,
  startedAt: number,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let inputTokens = 0, outputTokens = 0;
  let cacheReadTokens = 0, cacheCreateTokens = 0;
  // reasoningTokens: accumulated from thinking_delta SSE events and tokenized at
  // end-of-stream. Anthropic does not surface a dedicated counter; this is heuristic
  // and included in output_tokens already. Tracked here for observability.
  let thinkingText = '';
  let lineBuffer = '';
  let settled = false;

  const settle = async () => {
    if (settled) return;
    settled = true;
    try {
      const providerCost = estimateWorstCaseUsd(pricing, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens);
      const chargedCredits = applyMarkup(providerCost, ctx.markupPct);
      await settleAfterCall(ctx.platformPool, lease, chargedCredits);
      maybeTriggerAutoRefill({ pool: ctx.platformPool, redis: ctx.redis }, ctx.organizationId)
        .catch(err => console.warn('[messages] auto-refill failed:', err));
      maybeFireCreditsEmail(ctx.platformPool, ctx.userId)
        .catch(err => console.warn('[messages] credits-email failed:', err));
      const reasoningTokens = thinkingText.length > 0
        ? estimatePromptTokens([{ role: 'assistant', content: thinkingText }], canonicalId)
        : undefined;
      writeAiUsageRow(ctx.runtimePool, {
        appId: ctx.appId, organizationId: ctx.organizationId, userId: ctx.userId, model: canonicalId,
        router: chosenRouter as any,
        promptTokens: inputTokens, completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
        providerCostUsd: providerCost, chargedCreditsUsd: chargedCredits,
        markupPct: ctx.markupPct, fallbackChain: [], leaseId: lease.leaseId,
        keyType: 'platform', chargedToUser: true,
        cacheReadInputTokens: cacheReadTokens,
        cacheCreationInputTokens: cacheCreateTokens,
        reasoningTokens,
      }).catch(err => console.warn('[messages] usage-log write failed:', err));
      console.log(JSON.stringify({
        level: 'info',
        type: 'ai_router.call',
        app_id: ctx.appId,
        user_id: ctx.userId,
        canonical_model: canonicalId,
        chosen_router: chosenRouter,
        provider_cost_usd: providerCost,
        charged_credits_usd: chargedCredits,
        markup_pct: ctx.markupPct,
        latency_ms: Date.now() - startedAt,
        status: 200,
      }));
    } catch (e) {
      console.error('[messages] stream settle failed (non-fatal):', e);
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { await settle(); controller.close(); return; }
          lineBuffer += decoder.decode(value, { stream: true });
          const parts = lineBuffer.split('\n');
          lineBuffer = parts.pop() ?? '';
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as any;
              // Anthropic SSE: message_start carries input_tokens
              if (parsed?.type === 'message_start' && parsed?.message?.usage) {
                const u = parsed.message.usage;
                inputTokens = u.input_tokens ?? inputTokens;
                outputTokens = u.output_tokens ?? outputTokens;
                cacheReadTokens = u.cache_read_input_tokens ?? 0;
                cacheCreateTokens = u.cache_creation_input_tokens ?? 0;
              }
              // Anthropic SSE: message_delta carries output_tokens (final count)
              if (parsed?.type === 'message_delta' && parsed?.usage) {
                outputTokens = parsed.usage.output_tokens ?? outputTokens;
              }
              // Anthropic SSE: content_block_delta with thinking_delta accumulates thinking text
              if (parsed?.type === 'content_block_delta' && parsed?.delta?.type === 'thinking_delta') {
                thinkingText += parsed.delta.thinking ?? '';
              }
            } catch { /* ignore non-JSON */ }
          }
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
        await settle();
      }
    },
  });
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

    // Estimate cost for lease reservation
    const promptTokens = estimatePromptTokens(req.messages as any, stripped);
    const maxTokens = req.max_tokens ?? 4096;
    const worstUsd = estimateWorstCaseUsd(native.router, promptTokens, maxTokens);
    const reservedUsd = worstUsd * (1 + ctx.markupPct / 100);
    const lease = await acquireWithAudit(ctx, reservedUsd, leaseTtlSeconds(maxTokens));

    const startedAt = Date.now();

    if (req.stream) {
      let streamResult;
      try {
        streamResult = await native.adapter.nativeMessages(
          { ...normalized, stream: true },
          upstreamId,
          _headers,
        );
      } catch (err) {
        await settleAfterCall(ctx.platformPool, lease, 0);
        throw err;
      }
      const wrappedStream = wrapNativeAnthropicStreamForSettlement(
        streamResult.stream!,
        lease,
        native.router,
        ctx,
        stripped,
        native.router.name,
        startedAt,
      );
      return { status: streamResult.status, stream: wrappedStream, chosen: native.adapter.name, usage: null };
    }

    let result;
    try {
      result = await native.adapter.nativeMessages(normalized, upstreamId, _headers);
    } catch (err) {
      await settleAfterCall(ctx.platformPool, lease, 0);
      throw err;
    }

    const usage: AdapterUsage = result.usage ?? (() => {
      const u = (result.body as any)?.usage ?? {};
      return {
        promptTokens: u.input_tokens ?? 0,
        completionTokens: u.output_tokens ?? 0,
        totalCost: null,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        reasoningTokens: u.reasoning_tokens,
      };
    })();

    const providerCost = result.providerCostUsd
      ?? estimateWorstCaseUsd(
        native.router,
        usage.promptTokens,
        usage.completionTokens,
        usage.cache_read_input_tokens ?? 0,
        usage.cache_creation_input_tokens ?? 0,
      );
    const chargedCredits = applyMarkup(providerCost, ctx.markupPct);

    await settleAfterCall(ctx.platformPool, lease, chargedCredits);
    maybeTriggerAutoRefill({ pool: ctx.platformPool, redis: ctx.redis }, ctx.organizationId)
      .catch(err => console.error('[messages] auto-refill failed:', err));
    maybeFireCreditsEmail(ctx.platformPool, ctx.userId)
      .catch(err => console.error('[messages] credits-email failed:', err));
    writeAiUsageRow(ctx.runtimePool, {
      appId: ctx.appId, organizationId: ctx.organizationId, userId: ctx.userId, model: stripped,
      router: native.router.name as any,
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
      providerCostUsd: providerCost, chargedCreditsUsd: chargedCredits,
      markupPct: ctx.markupPct, fallbackChain: [], leaseId: lease.leaseId,
      keyType: 'platform', chargedToUser: true,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
      reasoningTokens: usage.reasoningTokens,
    }).catch(err => console.error('[messages] usage-log write failed:', err));
    console.log(JSON.stringify({
      level: 'info',
      type: 'ai_router.call',
      app_id: ctx.appId,
      user_id: ctx.userId,
      canonical_model: stripped,
      chosen_router: native.router.name,
      provider_cost_usd: providerCost,
      charged_credits_usd: chargedCredits,
      markup_pct: ctx.markupPct,
      latency_ms: Date.now() - startedAt,
      status: result.status,
    }));

    return { status: result.status, body: result.body, chosen: native.adapter.name, usage };
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
