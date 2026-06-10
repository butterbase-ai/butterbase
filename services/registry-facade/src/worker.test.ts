import { describe, it, expect } from 'vitest';
import { parseBasicAuth, checkRepoScope } from './auth.js';
import { parseRepoFromPath, rewriteLocation } from './worker.js';

describe('parseBasicAuth', () => {
  it('extracts the bb_sk_ key from Basic auth', () => {
    const header = 'Basic ' + btoa('app:bb_sk_test123');
    expect(parseBasicAuth(header)).toBe('bb_sk_test123');
  });
  it('returns null for missing/garbage headers', () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth('Bearer xyz')).toBeNull();
    expect(parseBasicAuth('Basic !!!')).toBeNull();
  });
  it('returns null when the password is not a bb_sk_ key', () => {
    expect(parseBasicAuth('Basic ' + btoa('app:hunter2'))).toBeNull();
  });
  it('returns null when there is no colon separator', () => {
    expect(parseBasicAuth('Basic ' + btoa('bb_sk_nocolon'))).toBeNull();
  });
});

describe('parseRepoFromPath', () => {
  it('extracts {app_id}/{name} from v2 API paths', () => {
    expect(parseRepoFromPath('/v2/app_abc123/game-server/blobs/uploads/')).toEqual({
      repo: 'app_abc123/game-server',
      rest: '/blobs/uploads/',
    });
    expect(parseRepoFromPath('/v2/app_abc123/game-server/manifests/latest')).toEqual({
      repo: 'app_abc123/game-server',
      rest: '/manifests/latest',
    });
  });
  it('returns null for the version check and malformed paths', () => {
    expect(parseRepoFromPath('/v2/')).toBeNull();
    expect(parseRepoFromPath('/v2/not-an-app/x/blobs/uploads/')).toBeNull();
  });
});

describe('checkRepoScope', () => {
  it('allows when the key app matches the repo app', () => {
    expect(checkRepoScope('app_abc123/game-server', 'app_abc123')).toBe(true);
    expect(checkRepoScope('app_abc123/game-server', 'app_other')).toBe(false);
  });
  it('does not allow a prefix-only match (app_abc vs app_abc123)', () => {
    // The slash delimiter means the full app segment must match.
    expect(checkRepoScope('app_abc123/game-server', 'app_abc')).toBe(false);
  });
});

describe('rewriteLocation', () => {
  const facadeHost = 'registry.butterbase.dev';
  const accountId = 'acc123';
  const upstreamHost = 'registry.cloudflare.com';

  it('rewrites absolute upstream Location to the facade host and strips the account namespace', () => {
    const loc = `https://${upstreamHost}/v2/${accountId}/app_abc/game-server/blobs/uploads/uuid?_state=x`;
    expect(rewriteLocation(loc, facadeHost, accountId, upstreamHost)).toBe(
      'https://registry.butterbase.dev/v2/app_abc/game-server/blobs/uploads/uuid?_state=x',
    );
  });

  it('strips the account namespace from a relative Location', () => {
    const loc = `/v2/${accountId}/app_abc/game-server/blobs/uploads/uuid`;
    expect(rewriteLocation(loc, facadeHost, accountId, upstreamHost)).toBe(
      '/v2/app_abc/game-server/blobs/uploads/uuid',
    );
  });

  it('leaves a Location with no upstream host or account namespace untouched', () => {
    expect(rewriteLocation('/v2/app_abc/game-server/blobs/uploads/uuid', facadeHost, accountId, upstreamHost)).toBe(
      '/v2/app_abc/game-server/blobs/uploads/uuid',
    );
  });
});
