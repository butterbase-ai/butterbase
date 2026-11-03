import { beforeAll, describe, expect, it } from 'vitest';
import { registerOfficePreviewPolicyProvider } from '../office-activity-preview-policy.js';

let project: typeof import('../office-activity-preview.js').previewOfficeToolValue;
beforeAll(async () => {
  const modulePath = '../office-activity-preview.js';
  try { project = (await import(modulePath)).previewOfficeToolValue; } catch { /* RED: module not yet implemented. */ }
});
const value = (input: unknown, toolName = 'select_rows', phase: 'input' | 'result' = 'result', action?: string) => {
  expect(project, 'the secure preview projector must be implemented').toBeTypeOf('function');
  const preview = project(input, { toolName, phase, action });
  if (preview.state === 'available') {
    expect(Buffer.byteLength(preview.text!, 'utf8')).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(preview), 'utf8')).toBeLessThanOrEqual(12288);
    expect(() => JSON.parse(preview.text!)).not.toThrow();
  }
  return preview;
};
const decoded = (input: unknown, tool?: string, phase?: 'input' | 'result', action?: string) => JSON.parse(value(input, tool, phase, action).text!);

describe('secure Office tool previews', () => {
  it.each([false, 0, '', null, [], {}])('preserves observed falsy and empty result %j', input => {
    expect(value(input).state).toBe('available');
    expect(decoded(input)).toEqual(input);
  });
  it('distinguishes a missing result from an observed null', () => {
    expect(value(undefined)).toMatchObject({ state: 'unavailable', reason: 'not_recorded' });
    expect(value(undefined)).not.toHaveProperty('text');
  });
  it('preserves deletion receipt metadata', () => {
    expect(decoded({ deleted: true, app_id: 'app' }, 'manage_app', 'result', 'delete')).toEqual({ deleted: true, app_id: 'app' });
  });
  it('retains MCP isError even when a structured body contains a superficially successful status', () => {
    expect(decoded({ isError: true, structuredContent: { status: 'ready' } }, 'manage_app', 'result', 'list'))
      .toEqual({ isError: true, result: { status: 'ready' } });
  });
  it('keeps all global privacy boundaries when an overlay approves broad fields', () => {
    registerOfficePreviewPolicyProvider({ resolve: context => context.toolName === 'test_reviewed' ? {
      input: [{ path: '**', classification: 'structured' }], result: [{ path: '**', classification: 'structured' }],
    } : undefined });
    const preview = value({ title: 'Useful', client_secret: 'SECRET_ALPHA', build_overrides: { NAME: 'SECRET_BETA' },
      nested: { oauth: { generic_id: 'SECRET_GAMMA' } }, code: 'const x="SECRET_DELTA"', headers: { hello: 'SECRET_EPSILON' } }, 'test_reviewed');
    expect(preview.text).not.toContain('SECRET_');
    expect(JSON.parse(preview.text!).title).toBe('Useful');
  });
  it('withholds raw top-level source and opaque file content', () => {
    expect(decoded('const password="SECRET_ALPHA"', 'read_file')).toBe('[withheld]');
  });
  it('does not reuse the KV data-key exception inside credential configuration', () => {
    const preview = value({ key: 'cart:1', config: { key: 'SECRET_ALPHA' } }, 'manage_kv', 'result', 'get');
    expect(JSON.parse(preview.text!)).toEqual({ key: 'cart:1', config: { key: '[withheld]' } });
  });
  it('keeps invalid-but-observed query keys and values without invented defaults', () => {
    expect(decoded({ app_id: 'app', table: 'orders', query: 'wrong-but-observed', limit: 0, offset: null, as_role: false }, 'select_rows', 'input'))
      .toEqual({ app_id: 'app', table: 'orders', query: 'wrong-but-observed', limit: 0, offset: null, as_role: false });
  });
  it('retains scoped row evidence while withholding unclassified columns', () => {
    expect(decoded([{ id: 'row-1', title: 'Order', status: 'pending', private_note: 'UNCLASSIFIED_NOTE', password: 'password-ALPHA' }]))
      .toEqual([{ id: 'row-1', title: 'Order', status: 'pending', private_note: '[withheld]', password: '[withheld]' }]);
  });
  it('redacts aliases and environment values without removing useful result metadata', () => {
    const fixture = { id: 'fn-1', status: 'ready', clientSecret: 'SECRET_ALPHA', privateKey: 'SECRET_BETA',
      byokKey: 'SECRET_GAMMA', headers: { Authorization: 'Bearer SECRET_DELTA' },
      envVars: { DISPLAY_NAME: 'SECRET_EPSILON' }, config: { environment: { harmless: 'SECRET_ZETA' } } };
    const preview = value(fixture, 'manage_function', 'result', 'get');
    expect(JSON.parse(preview.text!)).toMatchObject({ id: 'fn-1', status: 'ready', envVars: { DISPLAY_NAME: '[withheld]' } });
    expect(preview.redacted).toBe(true);
    expect(preview.text).not.toMatch(/SECRET_/);
  });
  it('withholds the generated service key but retains its stable ID and prefix', () => {
    expect(decoded({ key: 'bb_sk_SUPER_SECRET_ALPHA', keyId: 'key-1', prefix: 'bb_sk_short', name: 'Deploy' }, 'manage_auth_config', 'result', 'generate_service_key'))
      .toEqual({ key: '[withheld]', keyId: 'key-1', prefix: 'bb_sk_short', name: 'Deploy' });
  });
  it('keeps KV data keys distinct from API credential keys', () => {
    expect(decoded({ action: 'set', app_id: 'app', key: 'cart:1', value: { id: 'cart-1', status: false, token: 'SECRET_ALPHA' } }, 'manage_kv', 'input', 'set'))
      .toEqual({ action: 'set', app_id: 'app', key: 'cart:1', value: { id: 'cart-1', status: false, token: '[withheld]' } });
  });
  it('strips URL userinfo, all query values and fragments and hides signed capabilities', () => {
    const result = decoded({ url: 'https://user:password@example.test/path?name=SECRET_ALPHA#SECRET_BETA',
      downloadUrl: 'https://files.test/object?X-Amz-Signature=SECRET_GAMMA', objectId: 'obj-1' }, 'manage_storage', 'result', 'download_url');
    expect(result).toEqual({ url: 'https://example.test/path', downloadUrl: '[withheld]', objectId: 'obj-1' });
  });
  it('withholds OAuth catchall metadata and opaque integration bodies', () => {
    expect(decoded({ config: { provider: 'apple', enabled: false, provider_metadata: { teamId: 'SECRET_ALPHA', privateKey: 'SECRET_BETA' } } }, 'manage_oauth', 'result', 'get'))
      .toEqual({ config: { provider: 'apple', enabled: false, provider_metadata: '[withheld]' } });
    expect(decoded({ successful: true, data: { body: 'SECRET_GAMMA', id: 'x' } }, 'manage_integrations', 'result', 'execute_action'))
      .toEqual({ successful: true, data: '[withheld]' });
  });
  it('unwraps recognized MCP JSON envelopes and preserves partial receipt nesting', () => {
    const body = { inserted: 1, failed: 1, requires_approval: false, result: { status: 'partial', rows: [{ id: 'r' }] }, error: { code: 'row_failed', message: 'SECRET_ALPHA' } };
    const expected = { ...body, error: { code: 'row_failed', message: '[withheld]' } };
    expect(decoded({ content: [{ type: 'text', text: JSON.stringify(body) }] }, 'seed_database')).toEqual(expected);
    expect(decoded({ structuredContent: body, content: [{ type: 'text', text: 'IGNORED_SECRET' }] }, 'seed_database')).toEqual(expected);
  });
  it.each([
    { content: [{ type: 'text', text: 'Error: SECRET_ALPHA' }] },
    { content: [{ type: 'text', text: '{broken SECRET_ALPHA' }] },
    { content: [{ type: 'text', text: '{}' }, { type: 'text', text: 'SECRET_ALPHA' }] },
    { content: [{ type: 'image', data: 'SECRET_ALPHA', mimeType: 'image/png' }] },
  ])('withholds opaque or ambiguous MCP content %j', fixture => {
    const preview = value(fixture, 'invoke_function');
    expect(preview.text ?? '').not.toContain('SECRET_ALPHA');
    expect(preview.redacted).toBe(true);
  });
  it('never treats unknown tool fields or result variants as trusted business data', () => {
    expect(decoded({ id: 'UNKNOWN_SECRET', nested: { title: 'UNKNOWN_SECRET_2' } }, 'remote_unknown'))
      .toEqual({ id: '[withheld]', nested: { title: '[withheld]' } });
    expect(decoded({ unexplained_output: { id: 'UNKNOWN_SECRET' }, status: 'ready' }, 'manage_storage', 'result', 'list'))
      .toEqual({ unexplained_output: { id: '[withheld]' }, status: 'ready' });
  });
  it('does not expose source, SQL, binary, logs, or nested JSON-as-text', () => {
    const preview = value({ status: 'failed', code: 'const password="SECRET_ALPHA"', sql: 'SELECT SECRET_BETA',
      logs: ['SECRET_GAMMA'], output: 'SECRET_DELTA', body: '{"password":"SECRET_EPSILON"}', base64: 'SECRET_ZETA' }, 'run_sandbox_code');
    expect(preview.text).not.toContain('SECRET_');
    expect(JSON.parse(preview.text!).status).toBe('failed');
  });
  it('does not treat string errors or untyped array entries as reviewed structured records', () => {
    const preview = value({ error: 'SECRET_ALPHA', result: 'SECRET_BETA', warnings: ['SECRET_GAMMA'], items: ['SECRET_DELTA'],
      status: 'partial' }, 'seed_database');
    expect(preview.text).not.toContain('SECRET_');
    expect(JSON.parse(preview.text!).status).toBe('partial');
  });
  it('recognizes bearer, JWT, service and connection credentials inside approved strings', () => {
    for (const title of ['Bearer abcdefghijklmnop', 'bb_sk_abcdefghijklmnopqrstuvwxyz', 'postgres://user:secret@db.test/db', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature']) {
      expect(decoded({ title }).title).toBe('[withheld]');
    }
  });
  it('does not invoke getters or mutate prototypes and marks cycles', () => {
    let accessed = false;
    const fixture = JSON.parse('{"__proto__":{"polluted":"SECRET_ALPHA"},"id":"row"}');
    Object.defineProperty(fixture, 'title', { enumerable: true, get: () => { accessed = true; throw Error('SECRET_BETA'); } });
    fixture.result = fixture;
    const preview = value(fixture);
    expect(accessed).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(preview.text).not.toContain('SECRET_');
    expect(preview.truncated).toBe(true);
  });
  it('bounds deep, wide, cyclic and oversized Unicode without slicing JSON', () => {
    const cases = [Array.from({ length: 2000 }, (_, id) => ({ id, title: '😀\u0000'.repeat(1000) })),
      Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, i])),
      { result: { result: { result: { result: { result: { result: { title: 'too deep' } } } } } } },
      { title: '😀'.repeat(100000) }];
    for (const fixture of cases) expect(value(fixture).truncated).toBe(true);
  });
});
