import { describe, it, expect } from 'vitest';
import { resolveActivePlatformDbUrl } from './platform-db.js';

describe('resolveActivePlatformDbUrl', () => {
  it('returns primaryUrl when activeSide is primary', () => {
    expect(
      resolveActivePlatformDbUrl({ primaryUrl: 'postgres://primary', standbyUrl: 'postgres://standby', activeSide: 'primary' })
    ).toEqual('postgres://primary');
  });

  it('returns standbyUrl when activeSide is standby', () => {
    expect(
      resolveActivePlatformDbUrl({ primaryUrl: 'postgres://primary', standbyUrl: 'postgres://standby', activeSide: 'standby' })
    ).toEqual('postgres://standby');
  });

  it('throws when activeSide=standby but standbyUrl is empty', () => {
    expect(() =>
      resolveActivePlatformDbUrl({ primaryUrl: 'postgres://primary', standbyUrl: '', activeSide: 'standby' })
    ).toThrow(/NEON_PLATFORM_STANDBY_URL/);
  });

  it('throws when activeSide=primary but primaryUrl is empty', () => {
    expect(() =>
      resolveActivePlatformDbUrl({ primaryUrl: '', standbyUrl: '', activeSide: 'primary' })
    ).toThrow(/NEON_PLATFORM_PRIMARY_URL/);
  });
});
