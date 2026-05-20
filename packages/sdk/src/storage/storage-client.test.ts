import { describe, it, expect } from 'vitest';
import type { StorageObject } from '../types';

describe('StorageObject', () => {
  it('models a fully-populated object', () => {
    const o: StorageObject = {
      id: 'o1', user_id: 'u1', object_key: 'app_x/u1/file.png',
      filename: 'file.png', content_type: 'image/png',
      size_bytes: 1000, public: false, created_at: '2026-01-01',
    };
    expect(o.object_key).toContain('/');
  });

  it('user_id may be null for platform-auth uploads', () => {
    const o: StorageObject = {
      id: 'o1', user_id: null, object_key: 'k', filename: 'f',
      content_type: 'image/png', size_bytes: 1, created_at: '2026-01-01',
    };
    expect(o.user_id).toBeNull();
  });

  it('list response can omit public field', () => {
    const o: StorageObject = {
      id: 'o1', user_id: 'u1', object_key: 'k', filename: 'f',
      content_type: 'image/png', size_bytes: 1, created_at: '2026-01-01',
    };
    expect(o.public).toBeUndefined();
  });
});
