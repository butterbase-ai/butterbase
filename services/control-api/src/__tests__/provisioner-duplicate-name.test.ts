import { describe, it, expect } from 'vitest';
import { shouldReuseExistingApp } from '../services/provisioner.js';

/**
 * Clones are allowed to share a name — the subdomain differentiates them
 * (executeClone appends a random suffix on collision). insertAppRow's
 * name+owner idempotency check exists for /init double-submit protection and
 * must NOT apply to the clone path.
 *
 * When it did apply, insertAppRow returned early without inserting, while
 * executeClone carried on with its own freshly generated appId. Provisioning
 * then failed the app_db_connections -> apps FK, and waitForDestReady blocked
 * for its full 5-minute timeout waiting for a row nobody would ever write.
 */
describe('shouldReuseExistingApp', () => {
  const one = [{ id: 'app_existing' }] as never[];

  it('reuses a same-name app by default — /init double-submit protection', () => {
    expect(shouldReuseExistingApp(one, undefined)).toBe(true);
    expect(shouldReuseExistingApp(one, {})).toBe(true);
  });

  it('does NOT reuse when duplicate names are allowed — the clone path', () => {
    expect(shouldReuseExistingApp(one, { allowDuplicateName: true })).toBe(false);
  });

  it('never reuses when nothing matched', () => {
    expect(shouldReuseExistingApp([] as never[], undefined)).toBe(false);
    expect(shouldReuseExistingApp([] as never[], { allowDuplicateName: true })).toBe(false);
  });
});
