import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { compileRule, matchRules, detectConflict, type Role, type CompiledRule } from '../src/expose.js';
import { RedisClient } from '../src/redis-client.js';
import { loadRules, saveRule, deleteRule, nextDeclarationOrder } from '../src/expose.js';

describe('compileRule', () => {
  it('compiles a literal pattern', () => {
    const r = compileRule({ pattern: 'flags:home', read: 'public', write: 'deny' }, 0);
    expect(r.literalPrefixLen).toBe('flags:home'.length);
    expect(r.regex.test('flags:home')).toBe(true);
    expect(r.regex.test('flags:home:x')).toBe(false);
  });

  it('compiles a single-segment glob', () => {
    const r = compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    expect(r.regex.test('flags:home')).toBe(true);
    expect(r.regex.test('flags:home:banner')).toBe(false);
    expect(r.literalPrefixLen).toBe('flags:'.length);
  });

  it('compiles a multi-segment glob', () => {
    const r = compileRule({ pattern: 'cache:**', read: 'authed', write: 'authed' }, 0);
    expect(r.regex.test('cache:a')).toBe(true);
    expect(r.regex.test('cache:a:b')).toBe(true);
    expect(r.regex.test('cache:a:b:c')).toBe(true);
    expect(r.regex.test('other:x')).toBe(false);
  });

  it('compiles a template pattern, leaving placeholder for runtime substitution', () => {
    const r = compileRule({ pattern: 'session:{user.id}:*', read: 'owner', write: 'owner' }, 0);
    // After substitution of {user.id} with u123, "session:u123:tab1" should match.
    const substituted = r.regex.source.replace(/\\\{user\\.id\\\}/, 'u123');
    expect(new RegExp(substituted).test('session:u123:tab1')).toBe(true);
  });
});

describe('matchRules', () => {
  it('returns null when no rule matches', () => {
    const rules: CompiledRule[] = [];
    expect(matchRules(rules, 'foo')).toBeNull();
  });

  it('picks the longest literal-prefix match', () => {
    const rules = [
      compileRule({ pattern: '**', read: 'public', write: 'deny' }, 0),
      compileRule({ pattern: 'flags:*', read: 'authed', write: 'deny' }, 1),
    ];
    const m = matchRules(rules, 'flags:home');
    expect(m?.read).toBe('authed');
  });

  it('ties broken by declaration order', () => {
    const rules = [
      compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 0),
      compileRule({ pattern: 'flags:*', read: 'authed', write: 'deny' }, 1),
    ];
    // Conflict would normally reject this at expose-time, but matchRules itself is order-stable.
    expect(matchRules(rules, 'flags:home')?.read).toBe('public');
  });
});

describe('detectConflict', () => {
  it('flags duplicate patterns with different rules', () => {
    const r1 = compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    const r2 = compileRule({ pattern: 'flags:*', read: 'authed', write: 'deny' }, 1);
    expect(detectConflict([r1], r2)).not.toBeNull();
  });

  it('does not flag a duplicate pattern with identical rule (idempotent expose())', () => {
    const r1 = compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    const r2 = compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 1);
    expect(detectConflict([r1], r2)).toBeNull();
  });

  it('does not flag distinct patterns', () => {
    const r1 = compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    const r2 = compileRule({ pattern: 'session:*', read: 'owner', write: 'owner' }, 1);
    expect(detectConflict([r1], r2)).toBeNull();
  });

  it('does not flag a strict sub-pattern (longest-prefix-wins handles it)', () => {
    const r1 = compileRule({ pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    const r2 = compileRule({ pattern: 'flags:home:*', read: 'authed', write: 'authed' }, 1);
    expect(detectConflict([r1], r2)).toBeNull();
  });
});

describe('expose Redis helpers (integration)', () => {
  let c: RedisClient;
  const appId = 'expose-test';
  const HOST = process.env.KV_REDIS_HOST ?? 'localhost';
  const PORT = Number(process.env.KV_REDIS_PORT ?? 6390);
  const PASS = process.env.KV_REDIS_PASS ?? 'butterbase_dev_kv';

  beforeEach(async () => {
    c = await RedisClient.connect({ host: HOST, port: PORT, password: PASS, db: 15 });
    await c.flushTestDb();
  });

  afterEach(async () => {
    if (c) await c.close();
  });

  it('loadRules returns [] when no rules exist', async () => {
    expect(await loadRules(c, appId)).toEqual([]);
  });

  it('saveRule then loadRules returns the rule', async () => {
    await saveRule(c, appId, { pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    const rules = await loadRules(c, appId);
    expect(rules).toHaveLength(1);
    expect(rules[0].pattern).toBe('flags:*');
    expect(rules[0].read).toBe('public');
  });

  it('saveRule preserves declaration order across loads', async () => {
    await saveRule(c, appId, { pattern: 'a:*', read: 'public', write: 'deny' }, 0);
    await saveRule(c, appId, { pattern: 'b:*', read: 'authed', write: 'authed' }, 1);
    const rules = await loadRules(c, appId);
    rules.sort((x, y) => x.declarationOrder - y.declarationOrder);
    expect(rules.map((r) => r.pattern)).toEqual(['a:*', 'b:*']);
  });

  it('deleteRule removes the rule', async () => {
    await saveRule(c, appId, { pattern: 'flags:*', read: 'public', write: 'deny' }, 0);
    const removed = await deleteRule(c, appId, 'flags:*');
    expect(removed).toBe(true);
    expect(await loadRules(c, appId)).toEqual([]);
  });

  it('deleteRule on missing pattern returns false', async () => {
    expect(await deleteRule(c, appId, 'nope:*')).toBe(false);
  });

  it('nextDeclarationOrder returns 0 when empty, max+1 otherwise', async () => {
    expect(await nextDeclarationOrder(c, appId)).toBe(0);
    await saveRule(c, appId, { pattern: 'x:*', read: 'public', write: 'deny' }, 5);
    expect(await nextDeclarationOrder(c, appId)).toBe(6);
  });
});
