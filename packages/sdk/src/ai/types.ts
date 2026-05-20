export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
  | { type: 'video_url'; video_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletion {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatStreamChunk {
  delta: string;
  done: boolean;
}

export interface AiConfig {
  defaultModel?: string;
  byokKey?: string;
  maxTokensPerRequest?: number;
  allowedModels?: string[];
}

export interface AiUsage {
  totalTokens: number;
  totalRequests: number;
  totalCost: number;
  byModel: Array<{
    model: string;
    tokens: number;
    requests: number;
    cost: number;
  }>;
}

export interface EmbeddingRequest {
  model?: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

export interface EmbeddingVector {
  object: 'embedding';
  index: number;
  embedding: number[];
}

export interface EmbeddingResponse {
  object: 'list';
  model: string;
  data: EmbeddingVector[];
  usage: { prompt_tokens: number; total_tokens: number };
}

export interface AiModel {
  id: string;
  provider: string;
  capabilities: ('chat' | 'embed' | 'vision' | 'tool_use')[];
  context_window?: number;
  pricing?: { input_per_mtok?: number; output_per_mtok?: number };
}
