import { describe, expect, it } from 'vitest';
import { explicitOwnerAddress, resolveOwnerEmail, shouldIngestMessage } from './handler';

describe('outbound-only email ingestion', () => {
  it('prefers the authenticated user address', () => {
    expect(resolveOwnerEmail({ userEmail: 'me@x.com', integrationEmail: 'other@x.com' }))
      .toBe('me@x.com');
  });

  it('falls back to the connected account address', () => {
    expect(resolveOwnerEmail({ userEmail: null, integrationEmail: 'Owner@X.com' }))
      .toBe('owner@x.com');
  });

  it('returns null when no reliable identity exists', () => {
    expect(resolveOwnerEmail({ userEmail: null, integrationEmail: null })).toBeNull();
  });

  it('reads only explicit provider identity fields', () => {
    expect(explicitOwnerAddress({ emailAddress: 'me@x.com' })).toBe('me@x.com');
    expect(explicitOwnerAddress({ user_id: 'user-123' })).toBeNull();
    expect(explicitOwnerAddress({})).toBeNull();
  });

  it('rejects inbound messages and accepts sent ones', () => {
    expect(shouldIngestMessage({ sent: false })).toBe(false);
    expect(shouldIngestMessage({ sent: true })).toBe(true);
  });
});
