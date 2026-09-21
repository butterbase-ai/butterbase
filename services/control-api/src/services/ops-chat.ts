// services/control-api/src/services/ops-chat.ts
//
// Posts operator-facing alerts into a Google Chat space via an incoming
// webhook. This is the chat half of the ops alerting that OPS_ALERT_EMAIL
// covers by mail; callers generally fire both and treat neither as required.
//
// UNCONFIGURED IS SILENT AND INTENTIONAL, mirroring createSubstrateEmailSender:
// with GOOGLE_CHAT_OPS_WEBHOOK_URL unset this returns false and posts nothing,
// so local stacks and self-hosted deployments keep working untouched.
//
// THE WEBHOOK URL IS A BEARER SECRET. It carries `key` and `token` query
// params, and anyone holding it can post into the space as the webhook's
// identity. It must never reach a log line, an error message or an alert
// body — hence the deliberate absence of the URL from every console.error
// below, and the test that asserts it.

export interface OpsChatDeps {
  /** Injected for tests. Production uses global fetch. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
}

/** How long to wait on the webhook before giving up. An ops alert must never
 *  be able to wedge the sweep that produced it. */
const TIMEOUT_MS = 5_000;

/**
 * Send one plain-text message to the ops Google Chat space.
 *
 * Returns true when the webhook accepted it, false when chat is unconfigured
 * or the post failed. NEVER throws — alerting is best-effort by construction,
 * and a notification path that can throw takes down the thing it is reporting
 * on. Callers that care can branch on the boolean.
 */
export async function sendOpsChatMessage(text: string, deps: OpsChatDeps = {}): Promise<boolean> {
  const webhookUrl = process.env.GOOGLE_CHAT_OPS_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as NonNullable<OpsChatDeps['fetchImpl']>);
  if (!doFetch) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Status and body only. Not the URL.
      const body = await res.text().catch(() => '');
      console.error(`[ops-chat] webhook rejected the message: ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    // `err` from fetch can carry the request URL on some runtimes, so log the
    // message only — never the error object, and never the URL.
    const message = err instanceof Error ? err.message : 'unknown error';
    console.error(`[ops-chat] webhook post failed: ${message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
