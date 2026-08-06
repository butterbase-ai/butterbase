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

/**
 * Tokenizer work is bounded per request.
 *
 * js-tiktoken's merge loop is quadratic on repetitive input: 16 KB of a single
 * repeated character takes ~20s to encode, and a two-character cycle ("abab…")
 * is just as slow — so no cheap "looks repetitive" check can protect us.
 * Encoding is synchronous, so one oversized message would stall the event loop
 * and take the whole process down, not merely its own request.
 *
 * Rather than encode everything, we encode at most SAMPLE_CHARS of each string
 * and extrapolate by length, and cap how many samples one request may take.
 * Past that budget we fall back to a flat characters-per-token ratio. Worst
 * case is ~24 samples of 256 pathological characters, a few hundred
 * milliseconds, instead of unbounded.
 *
 * The result only sizes a credit lease; real billing comes from the provider's
 * returned usage at settle. A coarse estimate is therefore cheap, and an
 * unbounded encode is not.
 */
const SAMPLE_CHARS = 256;
const MAX_SAMPLES_PER_REQUEST = 24;
const FALLBACK_CHARS_PER_TOKEN = 4;

interface SampleBudget { left: number }

function countTokens(enc: Tiktoken, text: string, budget: SampleBudget): number {
  if (text.length === 0) return 0;
  if (budget.left <= 0) return Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN);
  budget.left -= 1;
  if (text.length <= SAMPLE_CHARS) return enc.encode(text).length;
  const sampleTokens = enc.encode(text.slice(0, SAMPLE_CHARS)).length;
  return Math.ceil(text.length * (sampleTokens / SAMPLE_CHARS));
}

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

  const budget: SampleBudget = { left: MAX_SAMPLES_PER_REQUEST };

  let total = 0;
  for (const msg of messages) {
    // Roles are a fixed, tiny vocabulary ('user', 'assistant', 'system',
    // 'tool') — one token each. Encoding them per message would be unbounded
    // work on a request carrying very many short messages.
    total += 1;
    total += 4; // per-message framing overhead, OpenAI cookbook approximation
    if (typeof msg.content === 'string') {
      total += countTokens(enc, msg.content, budget);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
          total += countTokens(enc, (part as { text: string }).text, budget);
        } else if (part.type === 'image_url') {
          total += IMAGE_URL_TOKEN_ALLOWANCE;
        }
        // Other part types ignored in v1.
      }
    }
  }
  return total;
}
