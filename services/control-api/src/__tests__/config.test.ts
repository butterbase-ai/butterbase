import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('config.aiRouter', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AI_ROUTER_PRESENCE_MODE;
    delete process.env.AI_ROUTER_DEFAULT_REGION;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('presenceModeEnabled is false by default', async () => {
    delete process.env.AI_ROUTER_PRESENCE_MODE;
    const mod = await import('../config.js');
    expect(mod.config.aiRouter.presenceModeEnabled).toBe(false);
  });

  it('presenceModeEnabled true when env=true', async () => {
    process.env.AI_ROUTER_PRESENCE_MODE = 'true';
    vi.resetModules();
    const mod = await import('../config.js');
    expect(mod.config.aiRouter.presenceModeEnabled).toBe(true);
  });

  it('defaultRegion defaults to us-east-1', async () => {
    delete process.env.AI_ROUTER_DEFAULT_REGION;
    const mod = await import('../config.js');
    expect(mod.config.aiRouter.defaultRegion).toBe('us-east-1');
  });

  it('defaultRegion uses env value when set', async () => {
    process.env.AI_ROUTER_DEFAULT_REGION = 'eu-west-1';
    vi.resetModules();
    const mod = await import('../config.js');
    expect(mod.config.aiRouter.defaultRegion).toBe('eu-west-1');
  });
});

describe('config.officeAllowedOrigins', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.OFFICE_URL;
    delete process.env.OFFICE_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('keeps the legacy single OFFICE_URL when no list is configured', async () => {
    process.env.OFFICE_URL = 'https://office-demo.example.test';
    const mod = await import('../config.js');
    expect(mod.config.officeAllowedOrigins).toEqual(['https://office-demo.example.test']);
  });

  it('accepts a comma-separated list and still includes the legacy origin', async () => {
    process.env.OFFICE_URL = 'https://office-demo.example.test';
    process.env.OFFICE_ALLOWED_ORIGINS =
      'https://office-customer.example.test, https://office-alt.example.test';
    const mod = await import('../config.js');
    expect(mod.config.officeAllowedOrigins).toEqual([
      'https://office-customer.example.test',
      'https://office-alt.example.test',
      'https://office-demo.example.test',
    ]);
  });

  it('normalizes trailing slashes and deduplicates', async () => {
    process.env.OFFICE_URL = 'https://office-demo.example.test/';
    process.env.OFFICE_ALLOWED_ORIGINS =
      'https://office-customer.example.test/,https://office-customer.example.test,https://office-demo.example.test';
    const mod = await import('../config.js');
    expect(mod.config.officeAllowedOrigins).toEqual([
      'https://office-customer.example.test',
      'https://office-demo.example.test',
    ]);
  });

  it.each([
    'https://office.example.test/app',
    'https://office.example.test?org=x',
    'https://user:pass@office.example.test',
    'ftp://office.example.test',
    'not-a-url',
  ])('rejects an invalid allowlist entry at startup: %s', async (entry) => {
    process.env.OFFICE_ALLOWED_ORIGINS = entry;
    await expect(import('../config.js')).rejects.toThrow(/OFFICE_ALLOWED_ORIGINS/);
  });

  it('rejects an invalid legacy OFFICE_URL at startup', async () => {
    process.env.OFFICE_URL = 'https://office.example.test/app';
    await expect(import('../config.js')).rejects.toThrow(/OFFICE_URL/);
  });
});
