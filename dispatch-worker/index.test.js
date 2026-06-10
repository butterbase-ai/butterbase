import { describe, it, expect } from 'vitest';
import { parseKvValue, resolveTargetScript } from './index.js';

describe('parseKvValue', () => {
  const env = { BUTTERBASE_REGION: 'us-east-1' };

  it('returns null for missing value', () => {
    expect(parseKvValue(null, env)).toBeNull();
  });

  it('parses JSON value', () => {
    expect(parseKvValue('{"appId":"a","region":"eu-west-1"}', env)).toEqual({ appId: 'a', region: 'eu-west-1' });
  });

  it('falls back to local region for JSON without region', () => {
    expect(parseKvValue('{"appId":"a"}', env)).toEqual({ appId: 'a', region: 'us-east-1' });
  });

  it('treats legacy string value as local region', () => {
    expect(parseKvValue('legacy-app-id', env)).toEqual({ appId: 'legacy-app-id', region: 'us-east-1' });
  });
});

describe('resolveTargetScript', () => {
  it('routes frontend paths to the app script', () => {
    expect(resolveTargetScript('/index.html', 'app_x').targetScript).toBe('app_x');
  });

  it('routes /_do/ to the DO script', () => {
    expect(resolveTargetScript('/_do/chat-room/r1', 'app_x').targetScript).toBe('app_x_do');
  });

  it('routes /_containers/{name} to the per-container script', () => {
    expect(resolveTargetScript('/_containers/game-server/r1/play', 'app_x').targetScript).toBe('app_x_ctr_game-server');
    expect(resolveTargetScript('/_containers/game-server', 'app_x').targetScript).toBe('app_x_ctr_game-server');
  });

  it('falls through to frontend for invalid container names', () => {
    expect(resolveTargetScript('/_containers/Bad_Name/x', 'app_x').targetScript).toBe('app_x');
  });

  it('carries a capability-specific missing message', () => {
    expect(resolveTargetScript('/_do/x/y', 'app_x').missingMessage).toContain('Durable Objects');
    expect(resolveTargetScript('/_containers/game-server', 'app_x').missingMessage).toContain('game-server');
    expect(resolveTargetScript('/page', 'app_x').missingMessage).toBe('App not deployed');
  });
});
