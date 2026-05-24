import { ErrorCodes, isAgentFriendlyError, type ErrorCode } from '@butterbase/shared';
import { ButterbaseError } from './base.js';
import {
  KvError, KvAuthError, KvForbiddenError, KvNotFoundError, KvKeyInvalidError, KvConnectionError,
  KvQuotaExceededError, KvRateLimitedError, KvCreditsExhaustedError, KvStorageFullError, KvKeysExhaustedError,
  KvValueTooLargeError, KvCasMismatchError, KvExposeConflictError,
} from './kv.js';

export { ButterbaseError };

export class AuthError       extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'AuthError'; } }
export class ValidationError extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'ValidationError'; } }
export class NotFoundError   extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'NotFoundError'; } }
export class QuotaError      extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'QuotaError'; } }
export class NetworkError    extends ButterbaseError { constructor(m: string, c: string = 'NETWORK_ERROR', s: number = 0, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'NetworkError'; } }

// Re-export KV error classes
export {
  KvError, KvAuthError, KvForbiddenError, KvNotFoundError, KvKeyInvalidError, KvConnectionError,
  KvQuotaExceededError, KvRateLimitedError, KvCreditsExhaustedError, KvStorageFullError, KvKeysExhaustedError,
  KvValueTooLargeError, KvCasMismatchError, KvExposeConflictError,
};

type ErrCls = new (m: string, c: string, s: number, r?: string, d?: unknown) => ButterbaseError;

// Exact code → class
const EXACT: Record<string, ErrCls> = {
  [ErrorCodes.AUTH_INVALID_API_KEY]: AuthError,
  [ErrorCodes.AUTH_INVALID_TOKEN]:   AuthError,
  [ErrorCodes.AUTH_INSUFFICIENT_PERMISSIONS]: AuthError,
  [ErrorCodes.RESOURCE_NOT_FOUND]:   NotFoundError,
};

// KV code → class
const KV_CODE_TO_CLASS: Record<string, ErrCls> = {
  KV_UNAUTHORIZED:  KvAuthError,
  KV_FORBIDDEN:     KvForbiddenError,
  KV_NOT_FOUND:     KvNotFoundError,
  KV_KEY_INVALID:   KvKeyInvalidError,
  KV_CONNECTION:    KvConnectionError,
  KV_VALUE_TOO_LARGE: KvValueTooLargeError,
  KV_CAS_MISMATCH:  KvCasMismatchError,
  KV_EXPOSE_CONFLICT: KvExposeConflictError,
  // lowercase quota codes from the control-api preHandler (Task 5)
  kv_rate_limited:      KvQuotaExceededError,
  kv_credits_exhausted: KvQuotaExceededError,
  kv_storage_full:      KvQuotaExceededError,
  kv_keys_exhausted:    KvQuotaExceededError,
  value_too_large:      KvValueTooLargeError,
};

export function classifyByCode(code: string): ErrCls | null {
  if (EXACT[code]) return EXACT[code];
  if (KV_CODE_TO_CLASS[code]) return KV_CODE_TO_CLASS[code];
  if (code.startsWith('KV_') || code.startsWith('kv_')) return KvError;
  if (code.startsWith('AUTH_'))       return AuthError;
  if (code.startsWith('VALIDATION_')) return ValidationError;
  if (code.startsWith('RESOURCE_'))   return NotFoundError;
  if (code.startsWith('QUOTA_'))      return QuotaError;
  if (code.startsWith('EXTERNAL_'))   return NetworkError;
  return null;
}

function classifyByStatus(status: number): ErrCls {
  if (status === 401 || status === 403) return AuthError;
  if (status === 400 || status === 422) return ValidationError;
  if (status === 404)                   return NotFoundError;
  if (status === 429)                   return QuotaError;
  if (status === 0 || status === 502 || status === 503) return NetworkError;
  return ButterbaseError;
}

/**
 * Parse a backend response into a typed ButterbaseError subclass.
 *
 * Dispatch order:
 *   1. If body matches AgentFriendlyError shape, use the `code` (exact match, then prefix).
 *   2. Otherwise fall back to HTTP status mapping.
 */
export function parseApiError(status: number, body: unknown): ButterbaseError {
  if (isAgentFriendlyError(body)) {
    const { code, message, remediation, details } = body.error;
    const Cls = classifyByCode(code) ?? classifyByStatus(status);
    return new Cls(message, code, status, remediation, details);
  }
  // Legacy shape — backend sometimes returns { error: "string" } or { message }.
  const message =
    body && typeof body === 'object'
      ? (typeof (body as any).error === 'string' ? (body as any).error
         : typeof (body as any).message === 'string' ? (body as any).message
         : 'Unknown error')
      : 'Unknown error';
  const Cls = classifyByStatus(status);
  return new Cls(message, `HTTP_${status}`, status);
}
