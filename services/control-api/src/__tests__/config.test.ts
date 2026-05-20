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
