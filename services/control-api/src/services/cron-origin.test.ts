import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { signCronOrigin, verifyCronOrigin, cronOriginHeaders } from './cron-origin.js';
import activityPlugin from '../plugins/app-activity.js';
import { verifyCronOrigin as verifyRuntimeOrigin } from '../../../deno-runtime/cron-origin.ts';

vi.mock('./app-activity.js', () => ({ markAppActive: async () => {} }));
const SECRET = 'cron-origin-test-secret';
const NOW = 1_800_000_000_000;
afterEach(() => vi.unstubAllEnvs());

describe('cron origin envelope', () => {
  it('supports signed execution budgets longer than fifteen minutes', () => {
    const token = signCronOrigin('app_demo', SECRET, NOW, 1235);
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW + 901_000)).toBe(true);
    expect(verifyRuntimeOrigin(token, 'app_demo', SECRET, NOW + 901_000)).toBe(true);
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW + 1235_000)).toBe(false);
  });
  it('keeps the standalone Deno verifier interoperable with valid and hostile envelopes', () => {
    const valid = signCronOrigin('app_demo', SECRET, NOW);
    const cases: Array<[unknown, string, string, number, boolean]> = [
      [valid, 'app_demo', SECRET, NOW, true],
      [valid, 'app_other', SECRET, NOW, false],
      [valid, 'app_demo', SECRET, NOW + 900_000, false],
      [valid, 'app_demo', SECRET, NOW - 31_000, false],
      [valid, 'app_demo', '', NOW, false],
      [valid + 'x', 'app_demo', SECRET, NOW, false],
      ['cron', 'app_demo', SECRET, NOW, false],
      [undefined, 'app_demo', SECRET, NOW, false],
    ];
    for (const [token, appId, secret, time, expected] of cases) {
      expect(verifyCronOrigin(token, appId, secret, time)).toBe(expected);
      expect(verifyRuntimeOrigin(token, appId, secret, time)).toBe(expected);
    }
  });
  it('signs a bounded app-scoped envelope that verifies independently', () => {
    const token = signCronOrigin('app_demo', SECRET, NOW);
    const [payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ appId: 'app_demo', iat: 1_800_000_000, exp: 1_800_000_900 });
    expect(createHmac('sha256', SECRET).update(`butterbase:cron-origin:v1.${payload}`).digest('base64url')).toBe(signature);
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW)).toBe(true);
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW + 899_000)).toBe(true);
  });
  it('rejects wrong scope, wrong secret, expiry and future-issued tokens', () => {
    const token = signCronOrigin('app_demo', SECRET, NOW);
    expect(verifyCronOrigin(token, 'app_other', SECRET, NOW)).toBe(false);
    expect(verifyCronOrigin(token, 'app_demo', 'wrong', NOW)).toBe(false);
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW + 900_000)).toBe(false);
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW - 31_000)).toBe(false);
  });
  it.each([undefined, '', 'cron', 'a.b.c', 'a.b', ['a', 'b'], 'x'.repeat(2048)])('ignores malformed client metadata: %j', (token) => {
    expect(verifyCronOrigin(token, 'app_demo', SECRET, NOW)).toBe(false);
  });
  it('rejects signed malformed claims', () => {
    for (const claims of [{ appId: 'app_demo', iat: '1800000000', exp: 1800000900 },
      { appId: 'app_demo', iat: 1800000000, exp: '1800000901' }, { appId: 'app_demo', iat: 1800000000, exp: 1799999999 }]) {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const sig = createHmac('sha256', SECRET).update(`butterbase:cron-origin:v1.${payload}`).digest('base64url');
      expect(verifyCronOrigin(`${payload}.${sig}`, 'app_demo', SECRET, NOW)).toBe(false);
    }
  });
  it('cannot mint trusted origin without configuration', () => {
    expect(() => signCronOrigin('app_demo', '', NOW)).toThrow('BUTTERBASE_INTERNAL_SECRET');
    expect(verifyCronOrigin(signCronOrigin('app_demo', SECRET, NOW), 'app_demo', '', NOW)).toBe(false);
  });
});

it('isolates concurrent cron and external request origin, including after awaits', async () => {
  vi.stubEnv('BUTTERBASE_INTERNAL_SECRET', SECRET);
  const app = Fastify();
  app.decorate('controlDb', {} as never);
  await app.register(activityPlugin);
  app.get('/v1/:app_id/origin', async (req) => {
    await new Promise(resolve => setTimeout(resolve, req.headers['x-butterbase-cron-origin'] ? 20 : 1));
    return { same: cronOriginHeaders('app_demo'), other: cronOriginHeaders('app_other') };
  });
  try {
    const token = signCronOrigin('app_demo');
    const [scheduled, external] = await Promise.all([
      app.inject({ url: '/v1/app_demo/origin', headers: { 'x-butterbase-cron-origin': token } }),
      app.inject('/v1/app_demo/origin'),
    ]);
    expect(scheduled.json()).toEqual({ same: { 'x-butterbase-cron-origin': token }, other: {} });
    expect(external.json()).toEqual({ same: {}, other: {} });
    expect(cronOriginHeaders('app_demo')).toEqual({});
  } finally { await app.close(); }
});
