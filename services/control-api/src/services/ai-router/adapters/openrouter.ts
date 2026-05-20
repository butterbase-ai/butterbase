import type { RouterAdapter, UpstreamModel, ChatCompletionRequest, EmbeddingRequest, AdapterResult, AdapterErrorKind, Modality } from './types.js';
import { AdapterError } from './types.js';

interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;        // default https://openrouter.ai/api/v1
  fetch?: typeof fetch;
  referer?: string;
  title?: string;
}

function classifyHttp(status: number): AdapterErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_available';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transport';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

export function openrouterAdapter(cfg: OpenRouterConfig): RouterAdapter {
  const base = cfg.baseUrl ?? 'https://openrouter.ai/api/v1';
  const fetcher = cfg.fetch ?? fetch;
  const referer = cfg.referer ?? 'https://butterbase.ai';
  const title = cfg.title ?? 'Butterbase';

  /**
   * Classify an OpenRouter /v1/models entry by `architecture.output_modalities`.
   * Defaults to 'chat' when unknown — preserves prior behavior for catalog
   * entries that pre-date the modality field.
   */
  function classifyModality(arch: { output_modalities?: string[] } | undefined): Modality {
    const outs = (arch?.output_modalities ?? []).map(s => s.toLowerCase());
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
    return {
      upstreamId: m.id,
      displayName: m.name,
      promptPricePerMtok: parseFloat(m.pricing.prompt) * 1_000_000,
      completionPricePerMtok: parseFloat(m.pricing.completion) * 1_000_000,
      contextLength: m.context_length,
      modality,
      // For non-chat modalities the per-call pricing isn't in this response —
      // stash architecture + pricing so future media-router code can recover it.
      ...(modality === 'chat'
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
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    if (req.stream) {
      return { status: res.status, stream: res.body ?? undefined, usage: null, providerCostUsd: null };
    }
    const json = await res.json() as any;
    return {
      status: res.status,
      body: json,
      usage: json.usage ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalCost: typeof json.usage.total_cost === 'number' ? json.usage.total_cost : null,
      } : null,
      providerCostUsd: typeof json.usage?.total_cost === 'number' ? json.usage.total_cost : null,
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
      throw new AdapterError('openrouter', res.status, classifyHttp(res.status), text || `HTTP ${res.status}`);
    }
    const json = await res.json() as any;
    return {
      status: res.status,
      body: json,
      usage: json.usage ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: 0,
        totalCost: typeof json.usage.total_cost === 'number' ? json.usage.total_cost : null,
      } : null,
      providerCostUsd: typeof json.usage?.total_cost === 'number' ? json.usage.total_cost : null,
    };
  }

  return {
    name: 'openrouter',
    toUpstreamId: (canonical) => canonical,
    listModels,
    chatCompletion,
    embedding,
  };
}
