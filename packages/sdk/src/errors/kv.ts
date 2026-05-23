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
