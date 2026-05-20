// services/control-api/src/services/ai-router/tokenizer.ts
import { Tiktoken, getEncoding } from 'js-tiktoken';

type Encoding = 'cl100k_base' | 'o200k_base';

let cl100k: Tiktoken | null = null;
let o200k: Tiktoken | null = null;

function getEnc(name: Encoding): Tiktoken {
  if (name === 'o200k_base') {
    if (!o200k) o200k = getEncoding('o200k_base');
    return o200k;
  }
  if (!cl100k) cl100k = getEncoding('cl100k_base');
  return cl100k;
}

/**
 * Pick a tokenizer encoding for a canonical model id. Non-OpenAI families
 * fall back to cl100k_base — a few percent off vs their native tokenizer,
 * good enough for lease-reservation math. Exact billing comes from the
 * router's returned usage.total_cost.
 */
export function pickEncodingForModel(canonicalId: string): Encoding {
  if (/^openai\/o\d/i.test(canonicalId)) return 'o200k_base';
  return 'cl100k_base';
}

const IMAGE_URL_TOKEN_ALLOWANCE = 85;

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: string; [key: string]: unknown };

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
}

/**
 * Estimate prompt tokens for a chat completion request.
 * Approximate — used for lease reservation, not billing.
 */
export function estimatePromptTokens(messages: ChatMessage[], canonicalModelId: string): number {
  if (messages.length === 0) return 0;
  const enc = getEnc(pickEncodingForModel(canonicalModelId));

  let total = 0;
  for (const msg of messages) {
    total += enc.encode(msg.role).length;
    total += 4; // per-message framing overhead, OpenAI cookbook approximation
    if (typeof msg.content === 'string') {
      total += enc.encode(msg.content).length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
          total += enc.encode((part as { text: string }).text).length;
        } else if (part.type === 'image_url') {
          total += IMAGE_URL_TOKEN_ALLOWANCE;
        }
        // Other part types ignored in v1.
      }
    }
  }
  return total;
}
