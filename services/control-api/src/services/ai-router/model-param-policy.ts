/**
 * Gemini models that no longer honour sampling parameters.
 *
 * Google deprecated `temperature`, `top_p` and `top_k` for Gemini 3.6 Flash and
 * every later Gemini release (3.5 Flash-Lite included). Strict resellers
 * enforce the per-model schema and reject the fields with HTTP 400
 * (`parameter_schema_invalid`) instead of ignoring them, so the same request
 * succeeds or fails depending on which upstream slot serves it.
 *
 * Stripping the fields costs nothing — the upstream already ignores them — and
 * keeps the request routable on every slot.
 *
 * Deliberately excluded: `presence_penalty`, `frequency_penalty`, `seed`, `n`,
 * `logit_bias`, `logprobs` and `top_logprobs`. Those are not deprecated — the
 * model simply has no equivalent — so silently dropping them would change
 * requested behaviour. Let the router fall through to an upstream that can
 * serve them, and surface a 400 if none can.
 */
export const DEPRECATED_SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'] as const;

const GEMINI_ID = /^google\/gemini-(\d+)(?:\.(\d+))?(.*)$/i;

export function modelIgnoresSamplingParams(canonicalId: string): boolean {
  const m = GEMINI_ID.exec(canonicalId.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  const suffix = m[3] ?? '';
  if (major >= 4) return true;
  if (major === 3 && minor >= 6) return true;
  return major === 3 && minor === 5 && /^[-._]?flash-lite/i.test(suffix);
}

/**
 * Remove the deprecated sampling params when the model ignores them. Returns
 * the same object (no copy) when there is nothing to strip, so callers can use
 * reference equality to tell whether the request changed.
 */
export function stripUnsupportedSamplingParams<T extends Record<string, unknown>>(
  req: T,
  canonicalId: string,
): T {
  if (!modelIgnoresSamplingParams(canonicalId)) return req;
  if (!DEPRECATED_SAMPLING_PARAMS.some(p => p in req)) return req;
  const out: Record<string, unknown> = { ...req };
  for (const p of DEPRECATED_SAMPLING_PARAMS) delete out[p];
  return out as T;
}
