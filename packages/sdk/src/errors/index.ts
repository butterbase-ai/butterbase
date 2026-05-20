import { ErrorCodes, isAgentFriendlyError, type ErrorCode } from '@butterbase/shared';

export class ButterbaseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly remediation?: string;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, remediation?: string, details?: unknown) {
    super(message);
    this.name = 'ButterbaseError';
    this.code = code;
    this.status = status;
    this.remediation = remediation;
    this.details = details;
  }
}

export class AuthError       extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'AuthError'; } }
export class ValidationError extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'ValidationError'; } }
export class NotFoundError   extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'NotFoundError'; } }
export class QuotaError      extends ButterbaseError { constructor(m: string, c: string, s: number, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'QuotaError'; } }
export class NetworkError    extends ButterbaseError { constructor(m: string, c: string = 'NETWORK_ERROR', s: number = 0, r?: string, d?: unknown) { super(m, c, s, r, d); this.name = 'NetworkError'; } }

type ErrCls = new (m: string, c: string, s: number, r?: string, d?: unknown) => ButterbaseError;

// Exact code → class
const EXACT: Record<string, ErrCls> = {
  [ErrorCodes.AUTH_INVALID_API_KEY]: AuthError,
  [ErrorCodes.AUTH_INVALID_TOKEN]:   AuthError,
  [ErrorCodes.AUTH_INSUFFICIENT_PERMISSIONS]: AuthError,
  [ErrorCodes.RESOURCE_NOT_FOUND]:   NotFoundError,
};

function classifyByCode(code: string): ErrCls | null {
  if (EXACT[code]) return EXACT[code];
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
