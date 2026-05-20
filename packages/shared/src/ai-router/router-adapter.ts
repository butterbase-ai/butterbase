export interface RouterAdapter {
  /** Stable adapter id used in catalog rows (e.g. "openrouter"). Must not leak internal codenames. */
  readonly id: string;

  /** Human-readable name shown in admin UIs. */
  readonly displayName: string;

  /** Returns the catalog of models this adapter can route to. */
  listModels(): Promise<RouterModel[]>;

  /** Forwards a chat completion request and returns a streaming response. */
  chatCompletion(req: RouterRequest): Promise<RouterResponse>;
}

export interface RouterModel {
  id: string;
  contextWindow: number;
  inputPricePerMtok: number;
  outputPricePerMtok: number;
  capabilities: ('vision' | 'tools' | 'json_mode')[];
}

export interface RouterRequest {
  modelId: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface RouterResponse {
  body: ReadableStream<Uint8Array>;
  inputTokens?: number;
  outputTokens?: number;
}
