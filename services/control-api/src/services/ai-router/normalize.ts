import overridesRaw from './normalize-overrides.json' with { type: 'json' };

export type RouterName = 'openrouter' | 'provider-primary' | 'provider-secondary';

const overrides = overridesRaw as unknown as Record<RouterName, Record<string, string>>;

interface PrefixRule {
  prefix: string;
  vendor: string;
  /**
   * If true, convert version separators in the model name from "-" to "." so
   * the canonical id matches OpenRouter's dotted form. AI Provider Primary (and one-api
   * derivatives in general) write versions as `claude-opus-4-7`, but OpenRouter
   * publishes the same model as `anthropic/claude-opus-4.7`. Without the swap,
   * the two never merge into the same canonical entry.
   */
  dottifyVersion?: boolean;
}

// Order matters — first match wins. Longer/more specific prefixes go first.
const VENDOR_BY_PREFIX: PrefixRule[] = [
  { prefix: 'claude-',     vendor: 'anthropic', dottifyVersion: true },
  { prefix: 'gpt-image',   vendor: 'openai'   }, // image model, keep as-is
  { prefix: 'gpt-',        vendor: 'openai'   },
  { prefix: 'o1',          vendor: 'openai'   },
  { prefix: 'o3',          vendor: 'openai'   },
  { prefix: 'o4',          vendor: 'openai'   },
  { prefix: 'deepseek-',   vendor: 'deepseek' },
  // AI Provider Primary calls Moonshot 'kimi-...'; OpenRouter publishes under 'moonshotai/'.
  { prefix: 'kimi-',       vendor: 'moonshotai' },
  { prefix: 'gemini-',     vendor: 'google' },
  { prefix: 'veo-',        vendor: 'google' }, // video model
  { prefix: 'glm-',        vendor: 'z-ai' },
  { prefix: 'grok-',       vendor: 'x-ai' },
  { prefix: 'qwen',        vendor: 'qwen' },
  { prefix: 'wan',         vendor: 'qwen' },   // Alibaba video, ships under Qwen vendor
  { prefix: 'happyhorse',  vendor: 'qwen' },   // Alibaba experimental video
  { prefix: 'minimax-',    vendor: 'minimax' },
  { prefix: 'seed-',       vendor: 'bytedance-seed' },
  { prefix: 'dreamina-',   vendor: 'bytedance' },
  { prefix: 'pixverse/',   vendor: 'pixverse' },
  { prefix: 'text-embedding', vendor: 'openai' },
  { prefix: 'amazon.titan-embed', vendor: 'amazon' },
];

/**
 * Convert version segments from hyphen-separated to dot-separated to align
 * with OpenRouter's canonical naming. Only segments that are pure digits get
 * dotted — preserves words like `flash-image-preview` or `pro-image-preview`.
 *
 * Example: `claude-opus-4-7` → `claude-opus-4.7`
 *          `claude-haiku-4-5` → `claude-haiku-4.5`
 *          `gemini-2-5-pro` → `gemini-2.5-pro`
 */
function dottifyVersion(id: string): string {
  // Replace `-<digits>-<digits>` and chained variants with dotted form.
  // Run twice to catch 3-segment versions like "4-7-codex" → "4.7-codex"... no,
  // only the digit-digit pair should join. We do one pass: any "-N-M" where both
  // sides start with digits becomes "-N.M". Repeat for chains: "1-2-3" → "1.2.3".
  let prev = id;
  let next = id;
  do {
    prev = next;
    next = next.replace(/-(\d+)-(\d+)/g, '-$1.$2');
  } while (next !== prev);
  return next;
}

/**
 * Map an upstream router's model id to the canonical id we surface to customers.
 * Returns null if no mapping is known — the refresher logs unknowns to
 * ai_catalog:unknown for ops to triage.
 *
 * OpenRouter ids are already canonical (vendor/model form), so we pass through
 * after a defensive shape check.
 */
export function canonicalizeUpstreamId(
  router: RouterName,
  upstreamId: string
): string | null {
  if (router === 'openrouter') {
    return /^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(upstreamId) ? upstreamId : null;
  }
  const exact = overrides[router]?.[upstreamId];
  if (exact) return exact;

  // Slash-prefixed ids (e.g. AI Provider Primary's `PixVerse/v6`) are vendor-tagged
  // already — lowercase the vendor segment.
  const slash = upstreamId.indexOf('/');
  if (slash > 0) {
    const lhs = upstreamId.slice(0, slash).toLowerCase();
    const rhs = upstreamId.slice(slash + 1);
    return `${lhs}/${rhs}`;
  }

  const lower = upstreamId.toLowerCase();
  for (const rule of VENDOR_BY_PREFIX) {
    if (lower.startsWith(rule.prefix.toLowerCase())) {
      const tail = rule.dottifyVersion ? dottifyVersion(upstreamId) : upstreamId;
      return `${rule.vendor}/${tail}`;
    }
  }
  return null;
}
