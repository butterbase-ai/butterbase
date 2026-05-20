// Notification preferences: silencing gate + one-click action tokens.
//
// The gate (isSilenced) runs in sendBillingEmail before SES. Action tokens
// are minted at email-send time and consumed when the recipient clicks a
// link in the email — see routes/notification-actions.ts for the HTTP side.
//
// Storage lives in the control DB (notification_preferences,
// notification_snoozes, notification_action_tokens — see migration 069).

import type { Pool } from 'pg';
import { randomBytes } from 'node:crypto';

export type BillingEmailTemplate = string; // re-typed loosely to avoid import cycle
export type SnoozeScope = 'template' | 'app' | 'function';
export type TokenAction = 'snooze_function_24h' | 'mute_function' | 'unsubscribe_template';

/**
 * Templates whose content is reproduced in the weekly digest. When a user
 * has digest_enabled=true, these per-event emails are suppressed so the
 * digest becomes the single weekly summary instead of stacking on top.
 * Other templates (payment_failed, etc.) are NEVER suppressed by the
 * digest — they're not in the digest and the user still needs to act.
 */
export const DIGEST_COVERED_TEMPLATES: ReadonlySet<string> = new Set([
  'function_failed',
  'deployment_failed',
]);

const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 7;

/**
 * Generate an unguessable URL-safe token. 256 bits of entropy — well above
 * the bar where brute-force enumeration is feasible against a single-use,
 * 7-day-expiring credential.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Decide whether a given (user, template, scope) email should be silenced
 * right now. Returns true if any of:
 *   - the user has unsubscribed from this template entirely
 *   - an active snooze covers the template
 *   - an active snooze covers the function (if functionId given)
 *   - an active snooze covers the app (if appId given)
 *
 * Read-only. Safe to call before SES. Falls open (returns false) on any
 * unexpected DB error so a partial outage of this table never prevents
 * delivery of important system mail. Caller passes a logger to surface it.
 */
export async function isSilenced(
  controlPool: Pool,
  userId: string,
  template: BillingEmailTemplate,
  scope: { appId?: string; functionId?: string } = {},
  log?: { warn: (p: Record<string, unknown>, m: string) => void },
): Promise<boolean> {
  try {
    const prefs = await controlPool.query<{ unsubscribed_templates: string[]; digest_enabled: boolean }>(
      `SELECT unsubscribed_templates, digest_enabled FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );
    const row = prefs.rows[0];
    if (row?.unsubscribed_templates?.includes(template)) return true;
    // Digest covers this template — user already gets it Sunday, no need to
    // also stack per-event emails.
    if (row?.digest_enabled && DIGEST_COVERED_TEMPLATES.has(template)) return true;

    // Build the set of (scope_type, scope_id) pairs that, if snoozed, would
    // silence this message. Always include the template itself.
    const scopes: Array<[SnoozeScope, string]> = [['template', template]];
    if (scope.appId) scopes.push(['app', scope.appId]);
    if (scope.functionId) scopes.push(['function', scope.functionId]);

    const params: unknown[] = [userId, new Date()];
    const tuples = scopes
      .map(([t, id], i) => `($${params.push(t)}::text, $${params.push(id)}::text)`)
      .join(',');
    const snz = await controlPool.query(
      `SELECT 1 FROM notification_snoozes
        WHERE user_id = $1
          AND snoozed_until > $2
          AND (scope_type, scope_id) IN (${tuples})
        LIMIT 1`,
      params,
    );
    return snz.rows.length > 0;
  } catch (err) {
    log?.warn({ err, userId, template }, 'notification-prefs: isSilenced check failed (fail-open)');
    return false;
  }
}

/**
 * Mint a single-use action token. Returns the raw token (the caller
 * embeds it in the outbound email URL). Token is good for TOKEN_TTL_DAYS;
 * consuming it once invalidates it.
 */
export async function createActionToken(
  controlPool: Pool,
  args: {
    userId: string;
    action: TokenAction;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await controlPool.query(
    `INSERT INTO notification_action_tokens (token, user_id, action, payload, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [token, args.userId, args.action, JSON.stringify(args.payload), expiresAt],
  );
  return token;
}

export interface ConsumedToken {
  userId: string;
  action: TokenAction;
  payload: Record<string, unknown>;
}

/**
 * Redeem a token: atomically mark it consumed and return its action +
 * payload. Returns null if the token is unknown, expired, or already
 * consumed — the route surfaces all three as the same "this link has
 * expired or been used" response to avoid leaking which is which.
 */
export async function consumeActionToken(
  controlPool: Pool,
  token: string,
): Promise<ConsumedToken | null> {
  const r = await controlPool.query<{ user_id: string; action: TokenAction; payload: Record<string, unknown> }>(
    `UPDATE notification_action_tokens
        SET consumed_at = now()
      WHERE token = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id, action, payload`,
    [token],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return { userId: row.user_id, action: row.action, payload: row.payload };
}

/**
 * Apply a snooze (24h window). Idempotent via primary-key UPSERT — calling
 * twice extends the snooze to a fresh 24h from the second call.
 */
export async function snoozeFunctionFor24h(
  controlPool: Pool,
  userId: string,
  functionId: string,
): Promise<void> {
  const snoozedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await controlPool.query(
    `INSERT INTO notification_snoozes (user_id, scope_type, scope_id, snoozed_until)
     VALUES ($1, 'function', $2, $3)
     ON CONFLICT (user_id, scope_type, scope_id)
       DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until`,
    [userId, functionId, snoozedUntil],
  );
}

/**
 * Mute a function indefinitely (snooze until year 9999). The user can
 * remove it from the settings page (Phase 3.5).
 */
export async function muteFunction(
  controlPool: Pool,
  userId: string,
  functionId: string,
): Promise<void> {
  await controlPool.query(
    `INSERT INTO notification_snoozes (user_id, scope_type, scope_id, snoozed_until)
     VALUES ($1, 'function', $2, '9999-01-01'::timestamptz)
     ON CONFLICT (user_id, scope_type, scope_id)
       DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until`,
    [userId, functionId],
  );
}

/**
 * Unsubscribe the user from a template entirely. Idempotent: adds to the
 * array only if absent.
 */
export async function unsubscribeFromTemplate(
  controlPool: Pool,
  userId: string,
  template: BillingEmailTemplate,
): Promise<void> {
  await controlPool.query(
    `INSERT INTO notification_preferences (user_id, unsubscribed_templates, updated_at)
     VALUES ($1, ARRAY[$2]::text[], now())
     ON CONFLICT (user_id)
       DO UPDATE SET
         unsubscribed_templates =
           CASE WHEN $2 = ANY(notification_preferences.unsubscribed_templates)
                THEN notification_preferences.unsubscribed_templates
                ELSE notification_preferences.unsubscribed_templates || $2
           END,
         updated_at = now()`,
    [userId, template],
  );
}
