import { describe, it, expect } from 'vitest';
import {
  KvError,
  KvAuthError,
  KvForbiddenError,
  KvNotFoundError,
  KvKeyInvalidError,
  KvConnectionError,
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
