import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

describe('config.aiRouter', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AI_ROUTER_PRESENCE_MODE;
    delete process.env.AI_ROUTER_DEFAULT_REGION;
    delete process.env.MINIMAX_REGION;
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

  it('minimaxRegion defaults to global_en', async () => {
    const mod = await import('../config.js');
    expect(mod.config.aiRouter.minimaxRegion).toBe('global_en');
  });

  it('minimaxRegion accepts cn_zh', async () => {
    process.env.MINIMAX_REGION = 'cn_zh';
    vi.resetModules();
    const mod = await import('../config.js');
    expect(mod.config.aiRouter.minimaxRegion).toBe('cn_zh');
  });
});
