import { ButterbaseError } from './base.js';

export class KvError extends ButterbaseError {
  constructor(message: string, code = 'KV_ERROR', status = 500, remediation?: string, details?: unknown) {
    super(message, code, status, remediation, details);
    this.name = 'KvError';
  }
}

export class KvAuthError extends KvError {
  constructor(m = 'unauthorized', c = 'KV_UNAUTHORIZED', s = 401, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvAuthError';
  }
}

export class KvForbiddenError extends KvError {
  constructor(m = 'forbidden', c = 'KV_FORBIDDEN', s = 403, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvForbiddenError';
  }
}

export class KvNotFoundError extends KvError {
  constructor(m = 'not found', c = 'KV_NOT_FOUND', s = 404, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvNotFoundError';
  }
}

export class KvKeyInvalidError extends KvError {
  constructor(m = 'invalid key', c = 'KV_KEY_INVALID', s = 400, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvKeyInvalidError';
  }
}

export class KvConnectionError extends KvError {
  constructor(m = 'connection error', c = 'KV_CONNECTION', s = 503, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvConnectionError';
  }
}

// Reserved for a future stricter-CAS endpoint that returns 409 on mismatch.
// Today the kv-gateway returns 200 {swapped:false} for normal CAS, so callers
// should use the boolean return from KvShim.cas(); this error is not thrown yet.
export class KvCasMismatchError extends KvError {
  constructor(m = 'cas mismatch', c = 'KV_CAS_MISMATCH', s = 409, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvCasMismatchError';
  }
}

export class KvExposeConflictError extends KvError {
  constructor(m = 'expose pattern conflicts with existing rule', c = 'KV_EXPOSE_CONFLICT', s = 409, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvExposeConflictError';
  }
}

export class KvValueTooLargeError extends KvError {
  constructor(m = 'value too large', c = 'KV_VALUE_TOO_LARGE', s = 413, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvValueTooLargeError';
  }
}

/** Parent / legacy alias for quota-class KV errors. */
export class KvQuotaExceededError extends KvError {
  constructor(m = 'quota exceeded', c = 'KV_QUOTA_EXCEEDED', s = 429, r?: string, d?: unknown) {
    super(m, c, s, r, d);
    this.name = 'KvQuotaExceededError';
  }
}

/** HTTP 429 – kv_rate_limited */
export class KvRateLimitedError extends KvQuotaExceededError {
  /** Seconds the caller should wait before retrying. */
  readonly retryAfterSec: number;

  constructor(retryAfterSec = 0, m?: string) {
    super(
      m ?? `rate limited; retry after ${retryAfterSec}s`,
      'kv_rate_limited',
      429,
    );
    this.name = 'KvRateLimitedError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** HTTP 402 – kv_credits_exhausted */
export class KvCreditsExhaustedError extends KvQuotaExceededError {
  constructor(m?: string) {
    super(
      m ?? 'credits exhausted; please top up your account',
      'kv_credits_exhausted',
      402,
    );
    this.name = 'KvCreditsExhaustedError';
  }
}

/** HTTP 507 – kv_storage_full */
export class KvStorageFullError extends KvQuotaExceededError {
  /** Bytes currently used. */
  readonly usedBytes: number;
  /** Storage cap in bytes. */
  readonly capBytes: number;

  constructor(usedBytes = 0, capBytes = 0, m?: string) {
    super(
      m ?? `storage full (${usedBytes} / ${capBytes} bytes used)`,
      'kv_storage_full',
      507,
    );
    this.name = 'KvStorageFullError';
    this.usedBytes = usedBytes;
    this.capBytes = capBytes;
  }
}

/** HTTP 507 – kv_keys_exhausted */
export class KvKeysExhaustedError extends KvQuotaExceededError {
  /** Current key count. */
  readonly keys: number;
  /** Maximum allowed keys. */
  readonly cap: number;

  constructor(keys = 0, cap = 0, m?: string) {
    super(
      m ?? `key limit reached (${keys} / ${cap} keys)`,
      'kv_keys_exhausted',
      507,
    );
    this.name = 'KvKeysExhaustedError';
    this.keys = keys;
    this.cap = cap;
  }
}
