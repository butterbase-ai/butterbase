/**
 * Best-effort extraction of the upstream provider's human-readable error from
 * an AdapterError message (usually the raw JSON response body). Falls back to
 * a generic sentence when the body is not JSON or carries no message.
 */
export function upstreamReason(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const msg = j?.error?.message ?? j?.message;
    if (typeof msg === 'string') return msg.slice(0, 500);
  } catch { /* not JSON */ }
  return 'The model provider rejected the request.';
}
