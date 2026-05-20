import { describe, it, expect } from 'vitest';
import type { ConnectedAccount } from './types';

describe('ConnectedAccount', () => {
  it('carries app_user_id', () => {
    const a: ConnectedAccount = {
      id: 'a1', app_user_id: 'u1', toolkit_slug: 'gmail',
      status: 'active', connected_at: '2026-01-01', last_used_at: null,
    };
    expect(a.app_user_id).toBe('u1');
  });
});
