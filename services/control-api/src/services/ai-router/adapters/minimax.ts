import type { MessagesRequest } from '../messages-schema.js';
import { extractReasoningTokens } from '../reasoning.js';
import {
  AdapterError,
  isUpstreamCreditExhaustionBody,
  type AdapterErrorKind,
  type AdapterResult,
  type ChatCompletionRequest,
  type RouterAdapter,
  type UpstreamModel,
} from './types.js';

export type MiniMaxRegion = 'global_en' | 'cn_zh';

export interface MiniMaxConfig {
  apiKey: string;
  region?: MiniMaxRegion;
  fetch?: typeof fetch;
}

const ENDPOINTS: Record<MiniMaxRegion, { openai: string; anthropic: string }> = {
  global_en: {
    openai: 'https://api.minimax.io/v1',
    anthropic: 'https://api.minimax.io/anthropic',
  },
  cn_zh: {
    openai: 'https://api.minimaxi.com/v1',
    anthropic: 'https://api.minimaxi.com/anthropic',
  },
};

const MODELS: readonly UpstreamModel[] = [
  {
    upstreamId: 'MiniMax-M3',
    displayName: 'MiniMax-M3',
    promptPricePerMtok: 0.6,
    completionPricePerMtok: 2.4,
    cacheReadPricePerMtok: 0.12,
    cacheWritePricePerMtok: null,
    contextLength: 1_000_000,
    inputModalities: ['text', 'image', 'video'],
    thinking: ['adaptive', 'disabled'],
    modality: 'chat',
  },
  {
    upstreamId: 'MiniMax-M2.7',
    displayName: 'MiniMax-M2.7',
    promptPricePerMtok: 0.3,
    completionPricePerMtok: 1.2,
    cacheReadPricePerMtok: 0.06,
    cacheWritePricePerMtok: 0.375,
    contextLength: 204_800,
    inputModalities: ['text'],
    thinking: ['always_on'],
    modality: 'chat',
  },
];

const CANONICAL_TO_UPSTREAM = new Map(
  MODELS.map(model => ['minimax/' + model.upstreamId, model.upstreamId]),
);

function classifyHttp(status: number): AdapterErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credits';
  if (status === 404) return 'model_not_available';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transport';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

function classifyMiniMaxCode(code: number): AdapterErrorKind {
  if (code === 1001 || code === 1013) return 'transport';
  if (code === 1002) return 'rate_limit';
  if (code === 1004) return 'auth';
  if (code === 1008) return 'insufficient_credits';
  if (code === 1039 || code === 2013) return 'bad_request';
  return 'unknown';
}

function throwIfErrorBody(status: number, body: unknown): void {
  if (isUpstreamCreditExhaustionBody(body)) {
    throw new AdapterError(
      'minimax',
      status,
      'insufficient_credits',
      'upstream provider is out of credits',
    );
  }
  if (!body || typeof body !== 'object') return;
  const baseResp = (body as { base_resp?: unknown }).base_resp;
  if (!baseResp || typeof baseResp !== 'object') return;
  const code = (baseResp as { status_code?: unknown }).status_code;
  if (typeof code !== 'number' || code === 0) return;
  throw new AdapterError(
    'minimax',
    status,
    classifyMiniMaxCode(code),
    'MiniMax API error ' + code,
  );
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toOpenAiBody(req: ChatCompletionRequest, upstreamId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(req as unknown as Record<string, unknown>),
    model: upstreamId,
  };
  delete body.session_id;
  delete body.cache_control;

  const thinking = body.thinking as { type?: unknown } | undefined;
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  const reasoningEffort = body.reasoning_effort;
  if (thinking?.type === 'enabled') {
    body.thinking = { type: 'adaptive' };
  } else if (
    body.thinking === undefined
    && (
      reasoningEffort === 'low'
      || reasoningEffort === 'medium'
      || reasoningEffort === 'high'
      || reasoning?.effort === 'low'
      || reasoning?.effort === 'medium'
      || reasoning?.effort === 'high'
    )
  ) {
    body.thinking = { type: 'adaptive' };
  }
  delete body.reasoning_effort;
  delete body.reasoning;

  if (body.stream === true) {
    const streamOptions = body.stream_options;
    body.stream_options = {
      ...(streamOptions && typeof streamOptions === 'object' ? streamOptions : {}),
      include_usage: true,
    };
  }
  return body;
}

function toAnthropicBody(req: MessagesRequest, upstreamId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(req as unknown as Record<string, unknown>),
    model: upstreamId,
  };
  const thinking = body.thinking as { type?: unknown } | undefined;
  if (thinking?.type === 'enabled') {
    body.thinking = { type: 'adaptive' };
  } else if (thinking?.type === 'adaptive' || thinking?.type === 'disabled') {
    body.thinking = { type: thinking.type };
  }
  return body;
}

export function minimaxAdapter(cfg: MiniMaxConfig): RouterAdapter {
  const endpoints = ENDPOINTS[cfg.region ?? 'global_en'];
  const fetcher = cfg.fetch ?? fetch;

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetcher(url, init);
    } catch (err) {
      throw new AdapterError(
        'minimax',
        502,
        'transport',
        err instanceof Error ? err.message : 'MiniMax transport error',
      );
    }
  }

  async function parseResponse(res: Response): Promise<unknown> {
    const text = await res.text().catch(() => '');
    const body = parseJsonText(text);
    if (!res.ok) {
      throwIfErrorBody(res.status, body);
      throw new AdapterError(
        'minimax',
        res.status,
        classifyHttp(res.status),
        'MiniMax HTTP ' + res.status,
      );
    }
    if (typeof body === 'string') {
      throw new AdapterError('minimax', 502, 'transport', 'MiniMax returned invalid JSON');
    }
    throwIfErrorBody(res.status, body);
    return body;
  }

  async function listModels(): Promise<UpstreamModel[]> {
    return MODELS.map(model => ({
      ...model,
      inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
      thinking: model.thinking ? [...model.thinking] : undefined,
    }));
  }

  async function chatCompletion(
    req: ChatCompletionRequest,
    upstreamId: string,
  ): Promise<AdapterResult> {
    const res = await call(endpoints.openai + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey,
      },
      body: JSON.stringify(toOpenAiBody(req, upstreamId)),
    });
    if (!res.ok) {
      await parseResponse(res);
    }
    if (req.stream && res.headers.get('content-type')?.includes('text/event-stream')) {
      if (!res.body) {
        throw new AdapterError('minimax', 502, 'transport', 'MiniMax stream response had no body');
      }
      return {
        status: res.status,
        stream: res.body,
        usage: null,
        providerCostUsd: null,
      };
    }

    const json = await parseResponse(res) as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: {
          cached_tokens?: number;
          cache_write_tokens?: number;
        };
        completion_tokens_details?: Record<string, unknown>;
      };
    };
    const usage = json.usage;
    const reasoningTokens = usage
      ? extractReasoningTokens(usage as unknown as Record<string, unknown>)
      : 0;
    return {
      status: res.status,
      body: json,
      usage: usage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalCost: null,
        cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens,
        cache_creation_input_tokens: usage.prompt_tokens_details?.cache_write_tokens,
        reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
      } : null,
      providerCostUsd: null,
    };
  }

  async function nativeMessages(
    req: MessagesRequest,
    upstreamId: string,
    headers: { anthropicVersion?: string; anthropicBeta?: string },
  ): Promise<AdapterResult> {
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey,
    };
    if (headers.anthropicVersion) {
      requestHeaders['anthropic-version'] = headers.anthropicVersion;
    }
    if (headers.anthropicBeta) {
      requestHeaders['anthropic-beta'] = headers.anthropicBeta;
    }

    const res = await call(endpoints.anthropic + '/v1/messages', {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(toAnthropicBody(req, upstreamId)),
    });
    if (!res.ok) {
      await parseResponse(res);
    }
    if (req.stream && res.headers.get('content-type')?.includes('text/event-stream')) {
      if (!res.body) {
        throw new AdapterError('minimax', 502, 'transport', 'MiniMax stream response had no body');
      }
      return {
        status: res.status,
        stream: res.body,
        usage: null,
        providerCostUsd: null,
      };
    }

    const json = await parseResponse(res) as {
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const usage = json.usage;
    return {
      status: res.status,
      body: json,
      usage: usage ? {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
        totalCost: null,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
      } : null,
      providerCostUsd: null,
    };
  }

  return {
    name: 'minimax',
    capabilities: {
      supportsNativeMessages: canonicalId => CANONICAL_TO_UPSTREAM.has(canonicalId),
    },
    toUpstreamId: canonicalId => CANONICAL_TO_UPSTREAM.get(canonicalId) ?? canonicalId,
    listModels,
    chatCompletion,
    nativeMessages,
  };
}
