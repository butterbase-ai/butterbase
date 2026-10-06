const GENERIC = 'The model provider rejected the request.';
const MAX_LEN = 500;

/**
 * Best-effort extraction of the upstream provider's human-readable error from
 * an AdapterError message (usually the raw JSON response body), made safe to
 * show a customer. Falls back to a generic sentence when the body is not JSON
 * or carries no message.
 *
 * Only `error.message` / `message` is ever read — never the rest of the body,
 * which can carry our upstream account's `user_id`.
 */
export function upstreamReason(raw: string): string {
  let msg: unknown;
  try {
    const j = JSON.parse(raw);
    msg = j?.error?.message ?? j?.message;
  } catch { /* not JSON */ }
  if (typeof msg !== 'string') return GENERIC;
  const text = scrub(flattenIssues(msg)).trim();
  return text ? text.slice(0, MAX_LEN) : GENERIC;
}

interface Issue { path: unknown[]; message: string }

function isIssue(v: unknown): v is Issue {
  return !!v && typeof v === 'object'
    && Array.isArray((v as Issue).path)
    && typeof (v as Issue).message === 'string';
}

/**
 * The Decisions API reports body validation failures as a JSON-encoded array
 * of issues ({ path, message, code, … }). Turn that into
 * "questions.q.type: Invalid …; state: …" so a developer sees what to fix
 * instead of pretty-printed JSON. Anything else is returned unchanged.
 */
function flattenIssues(msg: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(msg); } catch { return msg; }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isIssue)) return msg;
  return parsed
    .map(i => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Remove what the gateway must never disclose: which upstream we route through,
 * its URLs, and request / generation / account identifiers or keys. The model
 * vendor's own name (e.g. "Respan") stays — the customer chose that model.
 */
function scrub(text: string): string {
  return text
    .replace(/https?:\/\/(?:[\w-]+\.)*openrouter\.ai\S*/gi, 'the model provider documentation')
    .replace(/\bsk-or-[\w-]+/gi, '[redacted]')
    .replace(/\bgen-[\w-]{6,}/g, '[id]')
    .replace(/\buser_[A-Za-z0-9]{6,}/g, '[id]')
    .replace(/\breq[_-][A-Za-z0-9]{4,}/g, '[id]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]')
    .replace(/\bopenrouter\b/gi, 'the model provider')
    // Re-capitalise where the replacement now starts a sentence.
    .replace(/(^|[.!?]\s+)the model provider/g, (_m, lead: string) => `${lead}The model provider`);
}
