import type { RouterName } from '../normalize.js';

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

export interface ChatCompletionRequest {
  model: string; // canonical id; adapter translates to upstream id
  messages: Array<{ role: string; content: string | unknown[] }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

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
}

export type AdapterErrorKind =
  | 'transport'
  | 'rate_limit'
  | 'model_not_available'
  | 'auth'
  | 'bad_request'
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

export interface RouterAdapter {
  name: RouterName;
  toUpstreamId(canonicalId: string): string;
  listModels(): Promise<UpstreamModel[]>;
  chatCompletion(req: ChatCompletionRequest, upstreamId: string): Promise<AdapterResult>;
  embedding?(req: EmbeddingRequest, upstreamId: string): Promise<AdapterResult>;
  submitVideo?(req: VideoGenerationRequest, upstreamId: string): Promise<VideoSubmitResult>;
  pollVideo?(pollingUrl: string): Promise<VideoPollResult>;
  /** Fetch the raw MP4 bytes for a completed job. Pass through to caller as a stream. */
  fetchVideoContent?(upstreamJobId: string, index?: number): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }>;
  /**
   * Optional accessor returning a drift report from the most recent
   * `listModels()` call. Adapters that dynamically refresh their catalog from
   * an upstream source can use this to surface known modelIds vs. local
   * pricing snapshot drift. The report shape is adapter-specific; the
   * refresher logs it without interpretation.
   */
  getLastCatalogDrift?(): unknown;
}
