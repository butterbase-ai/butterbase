import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { ChatMessage, ChatOptions, ChatCompletion, ChatStreamChunk, AiConfig, AiUsage,
  EmbeddingRequest, EmbeddingResponse, AiModel } from './types.js';

export class AiClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  /**
   * Send a chat completion request (non-streaming)
   */
  async chat(
    messages: ChatMessage[],
    options?: ChatOptions
  ): Promise<ButterbaseResponse<ChatCompletion>> {
    try {
      const body: any = {
        model: options?.model || 'openai/gpt-4o-mini',
        messages,
        stream: false,
      };
      if (options?.temperature !== undefined) body.temperature = options.temperature;
      if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

      const data = await this.client.request<ChatCompletion>(
        'POST',
        `/v1/${this.client.appId}/chat/completions`,
        body
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Send a streaming chat completion request.
   * Returns an AsyncGenerator that yields text chunks.
   */
  async *chatStream(
    messages: ChatMessage[],
    options?: ChatOptions
  ): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const body: any = {
      model: options?.model || 'openai/gpt-4o-mini',
      messages,
      stream: true,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const response = await this.client.requestRaw(
      'POST',
      `/v1/${this.client.appId}/chat/completions`,
      body
    );

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop()!;

        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (payload === '[DONE]') {
            yield { delta: '', done: true };
            return;
          }
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              yield { delta, done: false };
            }
          } catch {
            // Skip malformed SSE frames
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Get AI configuration for this app
   */
  async getConfig(): Promise<ButterbaseResponse<AiConfig>> {
    try {
      const data = await this.client.request<{ config: AiConfig }>(
        'GET',
        `/v1/${this.client.appId}/ai/config`
      );
      return { data: data.config, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Update AI configuration for this app
   */
  async updateConfig(config: Partial<AiConfig>): Promise<ButterbaseResponse<AiConfig>> {
    try {
      const data = await this.client.request<{ config: AiConfig }>(
        'PUT',
        `/v1/${this.client.appId}/ai/config`,
        config
      );
      return { data: data.config, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Get AI usage summary
   */
  async getUsage(options?: { startDate?: string; endDate?: string }): Promise<ButterbaseResponse<AiUsage>> {
    try {
      const params = new URLSearchParams();
      if (options?.startDate) params.set('startDate', options.startDate);
      if (options?.endDate) params.set('endDate', options.endDate);
      const qs = params.toString();
      const path = `/v1/${this.client.appId}/ai/usage${qs ? `?${qs}` : ''}`;
      const data = await this.client.request<AiUsage>('GET', path);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Create embeddings for text input
   */
  async embed(req: EmbeddingRequest): Promise<ButterbaseResponse<EmbeddingResponse>> {
    try {
      const data = await this.client.request<EmbeddingResponse>(
        'POST', `/v1/${this.client.appId}/embeddings`, req,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * List available AI models
   */
  async listModels(): Promise<ButterbaseResponse<{ models: AiModel[] }>> {
    try {
      const data = await this.client.request<{ models: AiModel[] }>(
        'GET', `/v1/${this.client.appId}/ai/models`,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
