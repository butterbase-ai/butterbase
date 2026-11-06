import type { RouterAdapter, UpstreamModel, ChatCompletionRequest, EmbeddingRequest, DecisionRequest, AdapterResult, AdapterErrorKind, Modality, VideoGenerationRequest, VideoSubmitResult, VideoPollResult, ImageGenerationRequest, ImageSubmitResult, ImagePollResult, ImageSupportedParams } from './types.js';
import { AdapterError, isUpstreamCreditExhaustionBody } from './types.js';
import { extractReasoningTokens } from '../reasoning.js';
import { openrouterImageModel } from './openrouter-image-models.js';
import { normalizeOpenRouterVideoInputs } from './openrouter-video-inputs.js';

/**
 * OpenRouter has a dedicated image-generation endpoint at
 * POST /api/v1/images/generations. Request shape: { model, prompt, n?, size?,
 * seed? }. Response shape: { created, data: [{ b64_json, media_type }], usage:
 * { cost, ... } } — `response_format` is ignored; base64 is always returned.
 *
 * Reference images use OpenRouter's typed `input_references` array. Translate
 * Butterbase's `input_images` URLs into image_url parts, including for a single
 * reference. The OpenAI-style `image` field is silently ignored by Gemini.
 */

interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;        // default https://openrouter.ai/api/v1
  fetch?: typeof fetch;
  referer?: string;
  title?: string;
  decisionsUrl?: string;   // default https://openrouter.ai/api/alpha/decisions (outside /api/v1)
}

/**
 * Pull the billed USD cost out of an OpenRouter usage object.
 *
 * OpenRouter's chat/completions and embeddings APIs return the cost as
 * `usage.cost`; older docs used `usage.total_cost`. Accept either so the
 * router records what was actually billed instead of falling back to a
 * catalog-token estimate (which understates image models — they bill
 * per-image, not per-token).
 */
export function pickProviderCost(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  if (typeof u.cost === 'number') return u.cost;
  if (typeof u.total_cost === 'number') return u.total_cost;
  return null;
}

function classifyHttp(status: number): AdapterErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'insufficient_credits';
  if (status === 404) return 'model_not_available';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transport';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/**
 * Some upstreams (new-api-based proxies like imarouter) return HTTP 200 with
 * an OpenAI-shaped error envelope for "user quota insufficient". Others 429
 * with a specific `code`. We must inspect the parsed body BEFORE treating the
 * response as a valid completion.
 *
 * Also normalizes the message so we never leak an upstream request id,
 * upstream balance, or a non-English message to the caller.
 */
function throwIfUpstreamCreditExhaustion(router: 'openrouter', status: number, body: unknown): void {
  if (isUpstreamCreditExhaustionBody(body)) {
    // Deliberately generic — the caller must NOT see upstream request ids or
    // negative-balance figures. Fallback loop only reads err.kind anyway.
    throw new AdapterError(
      router,
      status,
      'insufficient_credits',
      'upstream provider is out of credits',
    );
  }
}

export function openrouterAdapter(cfg: OpenRouterConfig): RouterAdapter {
  const base = cfg.baseUrl ?? 'https://openrouter.ai/api/v1';
  const fetcher = cfg.fetch ?? fetch;
  const referer = cfg.referer ?? 'https://butterbase.ai';
  const title = cfg.title ?? 'Butterbase';
  const decisionsUrl = cfg.decisionsUrl ?? 'https://openrouter.ai/api/alpha/decisions';

  /**
   * Classify an OpenRouter /v1/models entry by `architecture.output_modalities`.
   * Defaults to 'chat' when unknown — preserves prior behavior for catalog
   * entries that pre-date the modality field.
   */
  function classifyModality(arch: { output_modalities?: string[] } | undefined): Modality {
    const outs = (arch?.output_modalities ?? []).map(s => s.toLowerCase());
    if (outs.includes('decisions')) return 'decisions';
    if (outs.includes('video')) return 'video';
    if (outs.includes('image')) return 'image';
    if (outs.includes('audio')) return 'audio';
    if (outs.includes('embedding')) return 'embedding';
    return 'chat';
  }

  /**
   * Parse one row of /v1/models into an UpstreamModel.
   */
  function parseModelRow(m: {
    id: string;
    name: string;
    pricing: { prompt: string; completion: string; [k: string]: unknown };
    context_length: number;
    architecture?: { output_modalities?: string[]; input_modalities?: string[] };
  }): UpstreamModel {
    const modality = classifyModality(m.architecture);
    // OpenRouter prices variable-cost routers (openrouter/auto, typesafe/jev-router)
    // as "-1". Stored raw that became -1,000,000/Mtok; clamp so the catalog never
    // holds a negative price. NaN (missing/garbled) also becomes 0.
    const toMtok = (s: string) => Math.max(0, parseFloat(s) * 1_000_000) || 0;
    return {
      upstreamId: m.id,
      displayName: m.name,
      promptPricePerMtok: toMtok(m.pricing.prompt),
      completionPricePerMtok: toMtok(m.pricing.completion),
      contextLength: m.context_length,
      modality,
      // Token-priced modalities carry no rawPricing.
      ...(modality === 'chat' || modality === 'decisions'
        ? {}
        : { rawPricing: { source: '/v1/models', architecture: m.architecture, pricing: m.pricing } }),
    };
  }

  async function listModels(): Promise<UpstreamModel[]> {
    type ModelRowJson = {
      data: Array<{
        id: string;
        name: string;
        pricing: { prompt: string; completion: string; [k: string]: unknown };
        context_length: number;
        architecture?: { output_modalities?: string[]; input_modalities?: string[] };
      }>;
    };

    // 1) Standard model list — chat + audio + chat-with-image-output models.
    const chatRes = await fetcher(`${base}/models`, {
      headers: { 'HTTP-Referer': referer, 'X-Title': title },
    });
    if (!chatRes.ok) {
      throw new AdapterError('openrouter', chatRes.status, classifyHttp(chatRes.status), `listModels HTTP ${chatRes.status}`);
    }
    const chatJson = await chatRes.json() as ModelRowJson;
    const byId = new Map<string, UpstreamModel>();
    for (const m of chatJson.data ?? []) byId.set(m.id, parseModelRow(m));

    // 2) Pure image generators — these don't appear in the default response.
    // Best-effort: failure just means we miss the 20-ish Recraft/etc. entries.
    try {
      const imgRes = await fetcher(`${base}/models?output_modalities=image`, {
        headers: { 'HTTP-Referer': referer, 'X-Title': title },
      });
      if (imgRes.ok) {
        const imgJson = await imgRes.json() as ModelRowJson;
        for (const m of imgJson.data ?? []) {
          if (!byId.has(m.id)) byId.set(m.id, parseModelRow(m));
        }
      }
    } catch (err) {
      console.warn('[openrouter] ?output_modalities=image fetch failed — skipping:', err);
    }

    // 3) Decision models (typed choice/yes-no/score, e.g. typesafe/jev-1.13).
    // Absent from the default response; best-effort like the image pass.
    try {
      const decRes = await fetcher(`${base}/models?output_modalities=decisions`, {
        headers: { 'HTTP-Referer': referer, 'X-Title': title },
      });
      if (decRes.ok) {
        const decJson = await decRes.json() as ModelRowJson;
        for (const m of decJson.data ?? []) {
          if (!byId.has(m.id)) byId.set(m.id, parseModelRow(m));
        }
      }
    } catch (err) {
      console.warn('[openrouter] ?output_modalities=decisions fetch failed — skipping:', err);
    }

    const out: UpstreamModel[] = Array.from(byId.values());

    // 2) Dedicated video-generation endpoint — separate schema, per-call pricing.
    // Failure here must not poison the rest of the catalog: log + continue.
    try {
      const videoRes = await fetcher(`${base}/videos/models`, {
        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'HTTP-Referer': referer, 'X-Title': title },
      });
      if (videoRes.ok) {
        const videoJson = await videoRes.json() as {
          data: Array<{
            id: string;
            name: string;
            canonical_slug?: string;
            description?: string;
            pricing_skus?: Record<string, string> | null;
            supported_resolutions?: string[] | null;
            supported_aspect_ratios?: string[] | null;
            supported_durations?: number[] | null;
            generate_audio?: boolean;
            seed?: boolean | null;
          }>;
        };
        for (const v of videoJson.data ?? []) {
          out.push({
            upstreamId: v.id,
            displayName: v.name,
            promptPricePerMtok: 0,
            completionPricePerMtok: 0,
            contextLength: 0,
            modality: 'video',
            rawPricing: {
              source: '/videos/models',
              pricing_skus: v.pricing_skus ?? null,
              supported_resolutions: v.supported_resolutions ?? null,
              supported_aspect_ratios: v.supported_aspect_ratios ?? null,
              supported_durations: v.supported_durations ?? null,
              generate_audio: v.generate_audio ?? false,
              seed: v.seed ?? null,
            },
          });
        }
      } else {
        console.warn(`[openrouter] /videos/models HTTP ${videoRes.status} — skipping video models`);
      }
    } catch (err) {
      console.warn('[openrouter] /videos/models fetch failed — skipping video models:', err);
    }

    return out;
  }

  async function chatCompletion(req: ChatCompletionRequest, upstreamId: string): Promise<AdapterResult> {
    const body = { ...req, model: upstreamId };
    const res = await fetcher(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Some upstreams (new-api / imarouter) return non-2xx with an OpenAI-shaped
      // credit-exhausted envelope. Try to parse and reclassify BEFORE surfacing.
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* body is not JSON */ }
      throwIfUpstreamCreditExhaustion('openrouter', res.status, parsed ?? text);
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    if (req.stream) {
      return { status: res.status, stream: res.body ?? undefined, usage: null, providerCostUsd: null };
    }
    const json = await res.json() as any;
    // new-api-based upstreams (imarouter et al.) return HTTP 200 with an error
    // envelope for `insufficient_user_quota` — inspect BEFORE treating as success.
    throwIfUpstreamCreditExhaustion('openrouter', res.status, json);
    // OpenRouter's chat-completions API returns the billed cost in `usage.cost`.
    // Older docs/responses used `usage.total_cost`; accept either so we don't
    // silently fall back to a catalog-token estimate (which under-counts image
    // models that bill per-image, not per-token).
    const cost = pickProviderCost(json.usage);
    const details = json.usage?.prompt_tokens_details;
    const rt = json.usage ? extractReasoningTokens(json.usage as Record<string, unknown>) : 0;
    return {
      status: res.status,
      body: json,
      usage: json.usage ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalCost: cost,
        cache_read_input_tokens: details?.cached_tokens,
        cache_creation_input_tokens: details?.cache_write_tokens,
        reasoningTokens: rt > 0 ? rt : undefined,
      } : null,
      providerCostUsd: cost,
    };
  }

  async function embedding(req: EmbeddingRequest, upstreamId: string): Promise<AdapterResult> {
    const body = { ...req, model: upstreamId };
    const res = await fetcher(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      throwIfUpstreamCreditExhaustion('openrouter', res.status, parsed ?? text);
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    const json = await res.json() as any;
    throwIfUpstreamCreditExhaustion('openrouter', res.status, json);
    const cost = pickProviderCost(json.usage);
    return {
      status: res.status,
      body: json,
      usage: json.usage ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: 0,
        totalCost: cost,
      } : null,
      providerCostUsd: cost,
    };
  }

  async function decisions(req: DecisionRequest, upstreamId: string): Promise<AdapterResult> {
    const res = await fetcher(decisionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify({ ...req, model: upstreamId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      throwIfUpstreamCreditExhaustion('openrouter', res.status, parsed ?? text);
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    const json = await res.json() as any;
    throwIfUpstreamCreditExhaustion('openrouter', res.status, json);
    const cost = pickProviderCost(json.usage);
    return {
      status: res.status,
      body: json,
      // Decisions report input_tokens/output_tokens, not prompt_/completion_tokens.
      usage: json.usage ? {
        promptTokens: json.usage.input_tokens ?? 0,
        completionTokens: json.usage.output_tokens ?? 0,
        totalCost: cost,
      } : null,
      providerCostUsd: cost,
    };
  }

  /**
   * Seed imagery is forwarded verbatim in whatever shape the caller supplied —
   * this upstream names the fields `frame_images` (temporal positioning via
   * `frame_type`) and `input_references` (style guidance, no positioning), and
   * the route accepts those names directly rather than translating them here.
   * The adapter deliberately does not inspect or reshape request parameters.
   */
  async function submitVideo(
    req: VideoGenerationRequest,
    upstreamId: string,
  ): Promise<VideoSubmitResult> {
    const normalized = normalizeOpenRouterVideoInputs(req);
    if (!normalized.ok) throw new AdapterError('openrouter', 400, 'bad_request', normalized.error);
    const body = { ...normalized.request, model: upstreamId };
    const res = await fetcher(`${base}/videos`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    const json = await res.json() as { id: string; polling_url: string; status: string };
    return {
      upstreamJobId: json.id,
      pollingUrl: json.polling_url,
      status: json.status as VideoSubmitResult['status'],
    };
  }

  async function pollVideo(pollingUrl: string): Promise<VideoPollResult> {
    const res = await fetcher(pollingUrl, {
      headers: {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    const json = await res.json() as {
      status: string;
      unsigned_urls?: string[];
      usage?: { cost?: number };
      error?: string;
    };
    return {
      status: json.status as VideoPollResult['status'],
      unsignedUrls: json.unsigned_urls,
      providerCostUsd: typeof json.usage?.cost === 'number' ? json.usage.cost : undefined,
      error: json.error,
    };
  }

  async function fetchVideoContent(
    upstreamJobId: string,
    index = 0,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    // Content endpoint serves raw bytes — only Authorization is needed.
    // HTTP-Referer / X-Title are skipped intentionally.
    const res = await fetcher(`${base}/videos/${encodeURIComponent(upstreamJobId)}/content?index=${index}`, {
      headers: { 'Authorization': `Bearer ${cfg.apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    if (!res.body) {
      throw new AdapterError('openrouter', 500, 'transport', 'video content response had no body');
    }
    return { stream: res.body, contentType: res.headers.get('content-type') ?? 'video/mp4' };
  }

  /**
   * OpenRouter's images endpoint (POST /api/v1/images/generations) is
   * OpenAI-Images-compatible: synchronous request/response, base64 bytes
   * returned inline. We wrap the b64 in a data: URI and stash it as the
   * "unsigned URL" — the /content route uses raw fetch() which Node 18+
   * supports on data: URIs, so no adapter-side content plumbing is needed.
   *
   * Returned status is always terminal ('completed' | 'failed'); routeImageSubmit
   * recognises this and settles the row inline without polling.
   */
  async function submitImage(req: ImageGenerationRequest, upstreamId: string): Promise<ImageSubmitResult> {
    const model = openrouterImageModel(req.model);
    const invalid = model?.params.validate?.(req);
    if (invalid) throw new AdapterError('openrouter', 400, 'bad_request', `${invalid.param}: ${invalid.message}`);
    // https://openrouter.ai/docs/api/api-reference/images/generate-an-image
    // Both single and multiple references use the same typed array. Keep the
    // caller's ordering so prompts can refer to images by their position.
    const inputReferences = req.input_images?.map(url => ({
      type: 'image_url' as const,
      image_url: { url },
    }));

    const body = {
      model: upstreamId,
      prompt: req.prompt,
      ...(req.n != null ? { n: req.n } : {}),
      ...(req.size ? { size: req.size } : {}),
      ...(req.seed != null ? { seed: req.seed } : {}),
      ...(inputReferences?.length ? { input_references: inputReferences } : {}),
      ...(req.mask ? { mask: req.mask } : {}),
      ...(model?.params.topLevel.has('aspect_ratio') && req.aspect_ratio !== undefined ? { aspect_ratio: req.aspect_ratio } : {}),
      ...Object.fromEntries([...(model?.params.provider ?? [])]
        .filter(key => req.provider?.[key] !== undefined).map(key => [key, req.provider![key]])),
    };

    const res = await fetcher(`${base}/${model?.endpoint ?? 'images/generations'}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
        'HTTP-Referer': referer,
        'X-Title': title,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      throwIfUpstreamCreditExhaustion('openrouter', res.status, parsed ?? text);
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }

    const json = await res.json() as {
      created?: number;
      data?: Array<{ b64_json?: string; media_type?: string }>;
      usage?: unknown;
    };
    throwIfUpstreamCreditExhaustion('openrouter', res.status, json);

    const first = json.data?.[0];
    if (!first || !json.data!.every(item => typeof item.b64_json === 'string' && item.b64_json.length > 0)) {
      // Deliberate: return failed rather than throw so the job row settles cleanly
      // (no lease refund; upstream cost was presumably $0 in this case).
      return {
        upstreamJobId: `or-img-${crypto.randomUUID()}`,
        pollingUrl: '',
        status: 'failed',
        error: 'OpenRouter images endpoint returned incomplete image data',
        providerCostUsd: pickProviderCost(json.usage) ?? undefined,
      };
    }

    const contentType = first.media_type ?? 'image/png';
    const dataUris = json.data!.map(item => `data:${item.media_type ?? 'image/png'};base64,${item.b64_json}`);

    return {
      upstreamJobId: `or-img-${crypto.randomUUID()}`,
      pollingUrl: '',  // sync-inline; route settles without polling
      status: 'completed',
      unsignedUrls: dataUris,
      providerCostUsd: pickProviderCost(json.usage) ?? undefined,
      contentType,
    };
  }

  async function pollImage(_pollingUrl: string): Promise<ImagePollResult> {
    // OpenRouter image path is sync-inline; route stores terminal state on submit.
    // If a client somehow triggers a poll, return non-terminal as a defensive no-op.
    return { status: 'completed' };
  }

  async function fetchImageContent(
    _upstreamJobId: string,
    _index = 0,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
    // Not used: the route serves content by streaming the stored unsigned URL directly.
    // But we implement it defensively so the adapter contract is complete.
    throw new AdapterError('openrouter', 501, 'unknown',
      'openrouter fetchImageContent is not implemented; route streams from stored URL');
  }

  function getSupportedImageParams(canonicalId: string): ImageSupportedParams | null {
    return openrouterImageModel(canonicalId)?.params ?? null;
  }

  return {
    name: 'openrouter',
    capabilities: { supportsNativeMessages: () => false },
    toUpstreamId: (canonical) => canonical,
    listModels,
    chatCompletion,
    embedding,
    decisions,
    submitVideo,
    pollVideo,
    fetchVideoContent,
    submitImage,
    pollImage,
    fetchImageContent,
    getSupportedImageParams,
  };
}
