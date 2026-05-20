// services/control-api/src/services/openrouter-gateway.ts
import { Pool } from 'pg';
import { logAiUsage } from './ai-usage-logger.js';
import { decrypt } from './crypto.js';
import { config } from '../config.js';
import { getRuntimeDbForApp } from './region-resolver.js';
import { getRuntimeDbPool } from './runtime-db.js';

export class OpenRouterError extends Error {
  constructor(message: string, public readonly code?: string, public readonly statusCode: number = 500) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: string; [key: string]: any };

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string | ContentPart[] }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  [key: string]: any;
}

interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

interface AiConfig {
  defaultModel?: string;
  byokKey?: string;
  maxTokensPerRequest?: number;
  allowedModels?: string[];
}

/**
 * Proxy chat completion request to OpenRouter
 */
export async function proxyChatCompletion(
  db: Pool,
  appId: string,
  userId: string | null,
  request: ChatCompletionRequest
): Promise<Response> {
  try {
    // Load app's AI config
    const config = await getAiConfig(db, appId);

    // Decrypt BYOK key if present
    let decryptedByokKey: string | undefined;
    if (config.byokKey) {
      try {
        // Check if encrypted (format: iv:ciphertext:authTag)
        if (config.byokKey.includes(':')) {
          const encryptionKey = process.env.AUTH_ENCRYPTION_KEY;
          if (!encryptionKey) {
            throw new OpenRouterError('Server encryption not configured', 'NO_ENCRYPTION_KEY');
          }
          decryptedByokKey = decrypt(config.byokKey, encryptionKey);
        } else {
          // Legacy unencrypted key
          decryptedByokKey = config.byokKey;
        }
      } catch (error) {
        throw new OpenRouterError(
          `Failed to decrypt BYOK key: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'DECRYPTION_FAILED'
        );
      }
    }

    // Determine key type and who pays
    const keyType = decryptedByokKey ? 'byok' : 'platform';
    const chargedToUser = keyType === 'platform';

    // Validate model if allowedModels is set
    if (config.allowedModels && config.allowedModels.length > 0) {
      if (!config.allowedModels.includes(request.model)) {
        throw new OpenRouterError(
          `Model ${request.model} not allowed. Allowed models: ${config.allowedModels.join(', ')}`,
          'MODEL_NOT_ALLOWED'
        );
      }
    }

    // Enforce max tokens
    if (config.maxTokensPerRequest && request.max_tokens) {
      if (request.max_tokens > config.maxTokensPerRequest) {
        request.max_tokens = config.maxTokensPerRequest;
      }
    }

    // Validate model exists on OpenRouter (uses cache, won't block on cache hit)
    try {
      const models = await getAvailableModels();
      const modelExists = models.some((m) => m.id === request.model);
      if (!modelExists) {
        throw new OpenRouterError(
          `Model "${request.model}" is not available. Use GET /v1/{appId}/ai/models to see available models.`,
          'MODEL_NOT_FOUND',
          404
        );
      }
    } catch (error) {
      if (error instanceof OpenRouterError && error.code === 'MODEL_NOT_FOUND') throw error;
      // If we can't fetch models (network issue), skip validation and let OpenRouter handle it
    }

    // Use BYOK key if configured, otherwise platform key
    const apiKey = decryptedByokKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new OpenRouterError('OpenRouter API key not configured', 'NO_API_KEY');
    }

    // Forward to OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.DASHBOARD_URL || 'https://butterbase.ai',
        'X-Title': 'Butterbase',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let message = `OpenRouter error (${response.status})`;
      let errorCode = 'OPENROUTER_ERROR';

      try {
        const parsed = JSON.parse(errorText);
        message = parsed.error?.message || message;
        if (response.status === 404) errorCode = 'MODEL_NOT_FOUND';
        else if (response.status === 401) errorCode = 'AUTH_FAILED';
        else if (response.status === 429) errorCode = 'RATE_LIMITED';
      } catch {
        message = errorText || message;
      }

      throw new OpenRouterError(message, errorCode, response.status);
    }

    // Handle streaming vs non-streaming
    if (request.stream) {
      return handleStreamingResponse(db, appId, userId, request.model, keyType, chargedToUser, response);
    } else {
      return handleNonStreamingResponse(db, appId, userId, request.model, keyType, chargedToUser, response);
    }
  } catch (error) {
    if (error instanceof OpenRouterError) {
      throw error;
    }
    throw new OpenRouterError(
      `Failed to proxy request: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PROXY_FAILED'
    );
  }
}

/**
 * Proxy embedding request to OpenRouter
 */
export async function proxyEmbedding(
  db: Pool,
  appId: string,
  userId: string | null,
  request: EmbeddingRequest
): Promise<Response> {
  try {
    const config = await getAiConfig(db, appId);

    let decryptedByokKey: string | undefined;
    if (config.byokKey) {
      try {
        if (config.byokKey.includes(':')) {
          const encryptionKey = process.env.AUTH_ENCRYPTION_KEY;
          if (!encryptionKey) {
            throw new OpenRouterError('Server encryption not configured', 'NO_ENCRYPTION_KEY');
          }
          decryptedByokKey = decrypt(config.byokKey, encryptionKey);
        } else {
          decryptedByokKey = config.byokKey;
        }
      } catch (error) {
        throw new OpenRouterError(
          `Failed to decrypt BYOK key: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'DECRYPTION_FAILED'
        );
      }
    }

    const keyType = decryptedByokKey ? 'byok' : 'platform';
    const chargedToUser = keyType === 'platform';

    if (config.allowedModels && config.allowedModels.length > 0) {
      if (!config.allowedModels.includes(request.model)) {
        throw new OpenRouterError(
          `Model ${request.model} not allowed. Allowed models: ${config.allowedModels.join(', ')}`,
          'MODEL_NOT_ALLOWED'
        );
      }
    }

    const apiKey = decryptedByokKey || process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new OpenRouterError('OpenRouter API key not configured', 'NO_API_KEY');
    }

    const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.DASHBOARD_URL || 'https://butterbase.ai',
        'X-Title': 'Butterbase',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let message = `OpenRouter error (${response.status})`;
      let errorCode = 'OPENROUTER_ERROR';

      try {
        const parsed = JSON.parse(errorText);
        message = parsed.error?.message || message;
        if (response.status === 404) errorCode = 'MODEL_NOT_FOUND';
        else if (response.status === 401) errorCode = 'AUTH_FAILED';
        else if (response.status === 429) errorCode = 'RATE_LIMITED';
      } catch {
        message = errorText || message;
      }

      throw new OpenRouterError(message, errorCode, response.status);
    }

    const data = await response.json();

    if (data.usage) {
      const { prompt_tokens, total_tokens } = data.usage;
      const costUsd = data.usage?.total_cost ?? data.generation?.total_cost ?? undefined;

      logAiUsage(db, {
        appId,
        userId,
        model: request.model,
        provider: 'openrouter',
        promptTokens: prompt_tokens || 0,
        completionTokens: 0,
        totalTokens: total_tokens || prompt_tokens || 0,
        keyType,
        chargedToUser,
        costUsd,
      }).catch((err) => {
        console.error('Failed to log AI usage:', err);
      });
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    if (error instanceof OpenRouterError) {
      throw error;
    }
    throw new OpenRouterError(
      `Failed to proxy request: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'PROXY_FAILED'
    );
  }
}

async function handleNonStreamingResponse(
  db: Pool,
  appId: string,
  userId: string | null,
  model: string,
  keyType: 'byok' | 'platform',
  chargedToUser: boolean,
  response: Response
): Promise<Response> {
  const data = await response.json();

  // Extract usage and cost from OpenRouter response
  if (data.usage) {
    const { prompt_tokens, completion_tokens, total_tokens } = data.usage;

    // OpenRouter returns cost in usage.total_cost (dollars) or in the generation object
    const costUsd = data.usage?.total_cost ?? data.generation?.total_cost ?? undefined;

    // Log usage asynchronously
    logAiUsage(db, {
      appId,
      userId,
      model,
      provider: 'openrouter',
      promptTokens: prompt_tokens,
      completionTokens: completion_tokens,
      totalTokens: total_tokens,
      keyType,
      chargedToUser,
      costUsd,
    }).catch((err) => {
      console.error('Failed to log AI usage:', err);
    });
  }

  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function handleStreamingResponse(
  db: Pool,
  appId: string,
  userId: string | null,
  model: string,
  keyType: 'byok' | 'platform',
  chargedToUser: boolean,
  response: Response
): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new OpenRouterError('No response body', 'NO_BODY');
  }

  const decoder = new TextDecoder();
  let promptTokens = 0;
  let completionTokens = 0;
  let streamCostUsd: number | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Log usage after stream completes
            if (promptTokens > 0 || completionTokens > 0) {
              logAiUsage(db, {
                appId,
                userId,
                model,
                provider: 'openrouter',
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens,
                keyType,
                chargedToUser,
                costUsd: streamCostUsd,
              }).catch((err) => {
                console.error('Failed to log AI usage:', err);
              });
            }
            controller.close();
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);

              if (data === '[DONE]') {
                continue;
              }

              try {
                const parsed = JSON.parse(data);

                // Extract usage and cost from final chunk
                if (parsed.usage) {
                  promptTokens = parsed.usage.prompt_tokens || 0;
                  completionTokens = parsed.usage.completion_tokens || 0;
                  streamCostUsd = parsed.usage.total_cost ?? parsed.generation?.total_cost ?? streamCostUsd;
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }

          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: { prompt: string; completion: string };
  context_length: number;
  architecture?: { tokenizer?: string; modality?: string };
}

let cachedModels: OpenRouterModel[] | null = null;
let cachedModelsAt = 0;
const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch available models from OpenRouter.
 * Cached for 1 hour to avoid hammering their API.
 */
export async function getAvailableModels(): Promise<OpenRouterModel[]> {
  if (cachedModels && Date.now() - cachedModelsAt < MODEL_CACHE_TTL) {
    return cachedModels;
  }

  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: {
      'HTTP-Referer': process.env.DASHBOARD_URL || 'https://butterbase.ai',
      'X-Title': 'Butterbase',
    },
  });

  if (!response.ok) {
    throw new OpenRouterError('Failed to fetch models from OpenRouter', 'MODELS_FETCH_FAILED', response.status);
  }

  const data = await response.json();
  cachedModels = (data.data || []).map((m: any) => ({
    id: m.id,
    name: m.name,
    pricing: m.pricing,
    context_length: m.context_length,
    architecture: m.architecture,
  }));
  cachedModelsAt = Date.now();

  return cachedModels!;
}

async function getAiConfig(db: Pool, appId: string): Promise<AiConfig> {
  const runtimePool = await getRuntimeDbForApp(db, appId);

  const result = await runtimePool.query(
    'SELECT ai_config FROM apps WHERE id = $1',
    [appId]
  );

  if (result.rows.length === 0) {
    throw new OpenRouterError('App not found', 'APP_NOT_FOUND');
  }

  return result.rows[0].ai_config || {};
}
