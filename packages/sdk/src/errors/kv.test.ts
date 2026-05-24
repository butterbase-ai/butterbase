import { describe, it, expect } from 'vitest';
import {
  KvError,
  KvAuthError,
  KvForbiddenError,
  KvNotFoundError,
  KvKeyInvalidError,
  KvConnectionError,
  KvQuotaExceededError,
  KvRateLimitedError,
  KvCreditsExhaustedError,
  KvStorageFullError,
  KvKeysExhaustedError,
  KvValueTooLargeError,
  classifyByCode,
} from './index';

describe('KvError hierarchy', () => {
  it('KvError has correct base properties', () => {
    const e = new KvError('test error', 'KV_ERROR', 500);
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_ERROR');
    expect(e.status).toBe(500);
    expect(e.message).toBe('test error');
    expect(e.name).toBe('KvError');
  });

  it('KvAuthError has correct code and status', () => {
    const e = new KvAuthError('unauthorized');
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_UNAUTHORIZED');
    expect(e.status).toBe(401);
  });

  it('KvForbiddenError has correct code and status', () => {
    const e = new KvForbiddenError('forbidden');
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_FORBIDDEN');
    expect(e.status).toBe(403);
  });

  it('KvNotFoundError has correct code and status', () => {
    const e = new KvNotFoundError('not found');
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_NOT_FOUND');
    expect(e.status).toBe(404);
  });

  it('KvKeyInvalidError has correct code and status', () => {
    const e = new KvKeyInvalidError('invalid key');
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_KEY_INVALID');
    expect(e.status).toBe(400);
  });

  it('KvConnectionError has correct code and status', () => {
    const e = new KvConnectionError('connection error');
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_CONNECTION');
    expect(e.status).toBe(503);
  });

  it('classifyByCode maps KV_UNAUTHORIZED to KvAuthError', () => {
    const Cls = classifyByCode('KV_UNAUTHORIZED');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('msg', 'KV_UNAUTHORIZED', 401);
      expect(e).toBeInstanceOf(KvAuthError);
    }
  });

  it('classifyByCode maps KV_NOT_FOUND to KvNotFoundError', () => {
    const Cls = classifyByCode('KV_NOT_FOUND');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('msg', 'KV_NOT_FOUND', 404);
      expect(e).toBeInstanceOf(KvNotFoundError);
    }
  });

  it('classifyByCode maps unknown KV_ code to KvError', () => {
    const Cls = classifyByCode('KV_WEIRD_UNKNOWN');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('msg', 'KV_WEIRD_UNKNOWN', 500);
      expect(e).toBeInstanceOf(KvError);
    }
  });

  it('classifyByCode preserves remediation and details', () => {
    const Cls = classifyByCode('KV_NOT_FOUND');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('not found', 'KV_NOT_FOUND', 404, 'check the key', { key: 'xyz' });
      expect(e.remediation).toBe('check the key');
      expect(e.details).toEqual({ key: 'xyz' });
    }
  });
});

describe('KvQuotaExceededError hierarchy', () => {
  it('KvQuotaExceededError is instanceof KvError and Error', () => {
    const e = new KvQuotaExceededError();
    expect(e).toBeInstanceOf(KvQuotaExceededError);
    expect(e).toBeInstanceOf(KvError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('KV_QUOTA_EXCEEDED');
    expect(e.status).toBe(429);
    expect(e.name).toBe('KvQuotaExceededError');
  });

  it('KvRateLimitedError has retryAfterSec and correct code/status', () => {
    const e = new KvRateLimitedError(30);
    expect(e).toBeInstanceOf(KvRateLimitedError);
    expect(e).toBeInstanceOf(KvQuotaExceededError);
    expect(e).toBeInstanceOf(KvError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('kv_rate_limited');
    expect(e.status).toBe(429);
    expect(e.retryAfterSec).toBe(30);
    expect(e.name).toBe('KvRateLimitedError');
    expect(e.message).toContain('30');
  });

  it('KvRateLimitedError defaults retryAfterSec to 0', () => {
    const e = new KvRateLimitedError();
    expect(e.retryAfterSec).toBe(0);
  });

  it('KvCreditsExhaustedError has correct code/status', () => {
    const e = new KvCreditsExhaustedError();
    expect(e).toBeInstanceOf(KvCreditsExhaustedError);
    expect(e).toBeInstanceOf(KvQuotaExceededError);
    expect(e).toBeInstanceOf(KvError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('kv_credits_exhausted');
    expect(e.status).toBe(402);
    expect(e.name).toBe('KvCreditsExhaustedError');
  });

  it('KvStorageFullError has usedBytes and capBytes', () => {
    const e = new KvStorageFullError(1024, 2048);
    expect(e).toBeInstanceOf(KvStorageFullError);
    expect(e).toBeInstanceOf(KvQuotaExceededError);
    expect(e).toBeInstanceOf(KvError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('kv_storage_full');
    expect(e.status).toBe(507);
    expect(e.usedBytes).toBe(1024);
    expect(e.capBytes).toBe(2048);
    expect(e.name).toBe('KvStorageFullError');
    expect(e.message).toContain('1024');
    expect(e.message).toContain('2048');
  });

  it('KvStorageFullError defaults to 0/0', () => {
    const e = new KvStorageFullError();
    expect(e.usedBytes).toBe(0);
    expect(e.capBytes).toBe(0);
  });

  it('KvKeysExhaustedError has keys and cap', () => {
    const e = new KvKeysExhaustedError(500, 1000);
    expect(e).toBeInstanceOf(KvKeysExhaustedError);
    expect(e).toBeInstanceOf(KvQuotaExceededError);
    expect(e).toBeInstanceOf(KvError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('kv_keys_exhausted');
    expect(e.status).toBe(507);
    expect(e.keys).toBe(500);
    expect(e.cap).toBe(1000);
    expect(e.name).toBe('KvKeysExhaustedError');
    expect(e.message).toContain('500');
    expect(e.message).toContain('1000');
  });

  it('KvValueTooLargeError is instanceof KvError and has correct defaults', () => {
    const e = new KvValueTooLargeError();
    expect(e).toBeInstanceOf(KvValueTooLargeError);
    expect(e).toBeInstanceOf(KvError);
    expect(e.code).toBe('KV_VALUE_TOO_LARGE');
    expect(e.status).toBe(413);
  });

  it('classifyByCode maps kv_rate_limited to KvQuotaExceededError', () => {
    const Cls = classifyByCode('kv_rate_limited');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('rate limited', 'kv_rate_limited', 429);
      expect(e).toBeInstanceOf(KvQuotaExceededError);
      expect(e).toBeInstanceOf(KvError);
    }
  });

  it('classifyByCode maps kv_credits_exhausted to KvQuotaExceededError', () => {
    const Cls = classifyByCode('kv_credits_exhausted');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('credits exhausted', 'kv_credits_exhausted', 402);
      expect(e).toBeInstanceOf(KvQuotaExceededError);
    }
  });

  it('classifyByCode maps kv_storage_full to KvQuotaExceededError', () => {
    const Cls = classifyByCode('kv_storage_full');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('storage full', 'kv_storage_full', 507);
      expect(e).toBeInstanceOf(KvQuotaExceededError);
    }
  });

  it('classifyByCode maps kv_keys_exhausted to KvQuotaExceededError', () => {
    const Cls = classifyByCode('kv_keys_exhausted');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('keys exhausted', 'kv_keys_exhausted', 507);
      expect(e).toBeInstanceOf(KvQuotaExceededError);
    }
  });

  it('classifyByCode maps value_too_large to KvValueTooLargeError', () => {
    const Cls = classifyByCode('value_too_large');
    expect(Cls).not.toBeNull();
    if (Cls) {
      const e = new Cls('value too large', 'value_too_large', 413);
      expect(e).toBeInstanceOf(KvValueTooLargeError);
    }
  });
});
