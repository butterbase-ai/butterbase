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
  defaultDecisionModel?: string;
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

export type AiModality = 'chat' | 'embedding' | 'image' | 'video' | 'audio' | 'decisions';
export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string>; [k: string]: unknown }
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string }; [k: string]: unknown }
  | { type: 'score'; instructions: string; criteria: string[]; [k: string]: unknown };
export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number>; [k: string]: unknown }
  | { type: 'noul'; noul: number; [k: string]: unknown }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string>; [k: string]: unknown };
export interface DecisionRequest { model?: string; state?: unknown; questions: Record<string, DecisionQuestion>; [k: string]: unknown }
export interface DecisionResponse { id: string; model: string; provider?: string; answers: Record<string, DecisionAnswer>; usage: { input_tokens: number; output_tokens: number; cost: number }; [k: string]: unknown }

export interface AiModel {
  id: string;
  provider: string;
  capabilities: ('chat' | 'embed' | 'vision' | 'tool_use')[];
  context_window?: number;
  pricing?: { input_per_mtok?: number; output_per_mtok?: number };
  modality?: AiModality;
}
