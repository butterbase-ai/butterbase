import type { RouterName } from '../normalize.js';
import type {
  ChatCompletionRequest as SchemaChatCompletionRequest,
  EmbeddingRequest as SchemaEmbeddingRequest,
} from '../schemas.js';

export type Modality = 'chat' | 'embedding' | 'image' | 'video' | 'audio';

export interface UpstreamModel {
  upstreamId: string;
  displayName: string;
  promptPricePerMtok: number;
  completionPricePerMtok: number;
  contextLength: number;
  // Defaults to 'chat' when omitted. Non-chat modalities (image/video/audio)
  // surface for future media-router integration; chat-completion selection
  // should filter by modality === 'chat'.
  modality?: Modality;
  // Router-native pricing payload for non-token-priced modalities (image, video,
  // audio). OpenRouter populates this with `pricing_skus`; AI Provider Primary with the
  // raw row from /api/pricing. Comparison/selection logic ignores this for
  // chat — it's stored so future media-router code has the per-call rate.
  rawPricing?: unknown;
}

/**
 * Adapter-facing request type — `z.infer<typeof chatCompletionRequestSchema>`.
 * The validator is the single source of truth, so any field the gateway
 * accepts is a field adapters can read.
 */
export type ChatCompletionRequest = SchemaChatCompletionRequest;
export type EmbeddingRequest = SchemaEmbeddingRequest;

export interface VideoGenerationRequest {
  model: string; // canonical id; adapter translates to upstream id
  prompt: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
  seed?: number;
  input_images?: string[];
  input_references?: string[];
  provider?: Record<string, unknown>;
}

export interface VideoSubmitResult {
  upstreamJobId: string;
  pollingUrl: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
}

export interface VideoPollResult {
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
  unsignedUrls?: string[];
  providerCostUsd?: number;
  error?: string;
}

export interface AdapterUsage {
  promptTokens: number;
  completionTokens: number;
  totalCost: number | null;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** Reasoning tokens consumed by thinking/reasoning models (e.g. o1, claude thinking). Undefined for non-reasoning models. */
  reasoningTokens?: number;
}

export interface AdapterResult {
  status: number;
  /** When streaming: stream of raw bytes ready to flush to client. */
  stream?: ReadableStream<Uint8Array>;
  /** When non-streaming: parsed JSON body. */
  body?: unknown;
  /** Usage extracted from the response (null when not parseable yet — e.g. streaming pre-DONE). */
  usage: AdapterUsage | null;
  /** Provider's reported cost, in USD; null when adapter can't extract it. */
  providerCostUsd: number | null;
  /**
   * Optional post-hoc cost lookup. Used by streaming adapters that cannot
   * report cost inline (e.g. iMARouter's chat stream). wrapStreamForSettlement
   * awaits this after the upstream emits [DONE] when no in-stream cost was
   * observed.
   */
  costFetcher?: () => Promise<number | null>;
}

export type AdapterErrorKind =
  | 'transport'
  | 'rate_limit'
  | 'model_not_available'
  | 'auth'
  | 'bad_request'
  | 'insufficient_credits'
  | 'unknown';

export class AdapterError extends Error {
  constructor(
    public readonly router: RouterName,
    public readonly statusCode: number,
    public readonly kind: AdapterErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Upstream error `code` strings that indicate the *upstream account* is out of
 * credits (not the caller). All of these must fall over to another provider.
 *
 * Sources:
 *  - OpenAI:  `insufficient_quota`
 *  - Anthropic: `credit_balance_too_low` (in the `error.type` field)
 *  - new-api (imarouter et al.): `insufficient_user_quota`
 *  - OpenRouter: some upstreams echo `insufficient_credits` or return 402
 *
 * These often arrive as HTTP 200 with an error envelope, or as 429 with a
 * distinct code — status alone is not enough. Match on the payload's
 * `error.code` OR `error.type` string.
 */
export const UPSTREAM_INSUFFICIENT_CREDIT_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'insufficient_user_quota',
  'insufficient_credits',
  'credit_balance_too_low',
  'billing_hard_limit_reached',
  'account_deactivated',
]);

/**
 * Best-effort inspection of an OpenAI-shaped error body for upstream-credit
 * exhaustion. Returns true when we should treat the response as
 * `insufficient_credits` regardless of HTTP status. Handles both:
 *   { error: { code, type, message } }
 * and bare-string bodies containing one of the known codes.
 */
export function isUpstreamCreditExhaustionBody(body: unknown): boolean {
  if (!body) return false;
  if (typeof body === 'string') {
    for (const code of UPSTREAM_INSUFFICIENT_CREDIT_CODES) {
      if (body.includes(code)) return true;
    }
    return false;
  }
  if (typeof body !== 'object') return false;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  const type = (err as { type?: unknown }).type;
  if (typeof code === 'string' && UPSTREAM_INSUFFICIENT_CREDIT_CODES.has(code)) return true;
  if (typeof type === 'string' && UPSTREAM_INSUFFICIENT_CREDIT_CODES.has(type)) return true;
  return false;
}

export interface AdapterCapabilities {
  /** True when this adapter can forward a request directly to upstream
   *  Anthropic Messages API (POST /v1/messages) for the given canonical
   *  model id. When false, the messages router must translate to and
   *  from chat-completions. */
  supportsNativeMessages: (canonicalId: string) => boolean;
}

export interface RouterAdapter {
  name: RouterName;
  capabilities: AdapterCapabilities;
  toUpstreamId(canonicalId: string): string;
  listModels(): Promise<UpstreamModel[]>;
  chatCompletion(req: ChatCompletionRequest, upstreamId: string): Promise<AdapterResult>;
  embedding?(req: EmbeddingRequest, upstreamId: string): Promise<AdapterResult>;
  submitVideo?(req: VideoGenerationRequest, upstreamId: string): Promise<VideoSubmitResult>;
  pollVideo?(pollingUrl: string): Promise<VideoPollResult>;
  /** Fetch the raw MP4 bytes for a completed job. Pass through to caller as a stream. */
  fetchVideoContent?(upstreamJobId: string, index?: number): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;
  /**
   * Native Anthropic Messages API passthrough. When implemented, `routeMessages`
   * skips the chat-completions translation layer and forwards the request body
   * directly to the upstream provider's `/v1/messages` endpoint (non-streaming only;
   * streaming native path is wired in a later task).
   */
  nativeMessages?(
    req: import('../messages-schema.js').MessagesRequest,
    upstreamId: string,
    headers: { anthropicVersion?: string; anthropicBeta?: string },
  ): Promise<AdapterResult>;
  /**
   * Optional accessor returning a drift report from the most recent
   * `listModels()` call. Adapters that dynamically refresh their catalog from
   * an upstream source can use this to surface known modelIds vs. local
   * pricing snapshot drift. The report shape is adapter-specific; the
   * refresher logs it without interpretation.
   */
  getLastCatalogDrift?(): unknown;
}
