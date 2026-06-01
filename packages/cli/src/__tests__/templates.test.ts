// submodules/butterbase-oss/packages/cli/src/__tests__/templates.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { templatesCommand } from '../commands/templates.js';
import type { ListTemplatesResponse } from '../lib/repo-api.js';

const MOCK_RESPONSE: ListTemplatesResponse = {
  items: [
    {
      app_id: 'app_abc123',
      name: 'My Template',
      region: 'us-east-1',
      owner_id: 'user_1',
      owner_display_name: 'Alice',
      created_at: '2024-01-01T00:00:00Z',
      fork_count: 42,
      has_repo: true,
      schema_summary: { table_count: 3, function_count: 1 },
    },
  ],
  total: 1,
  limit: 20,
  offset: 0,
};

describe('templatesCommand', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.BUTTERBASE_API_KEY = 'TK';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
    if (prevHome !== undefined) process.env.HOME = prevHome;
  });

  it('json mode: round-trips the API response exactly', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 }),
    );

    await templatesCommand({ json: true });

    const printed = logSpy.mock.calls.map((c: any[]) => String(c[0] ?? '')).find(s => s.trim().startsWith('{'));
    expect(printed).toBeDefined();
    const parsed = JSON.parse(printed!);
    expect(parsed).toEqual(MOCK_RESPONSE);
  });

  it('json mode: hits GET /v1/templates with no query string when no opts', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    });

    await templatesCommand({ json: true });

    expect(capturedUrl).toMatch(/\/v1\/templates$/);
  });

  it('json mode: forwards q, sort, region, limit, offset as query params', async () => {
    let capturedUrl = '';
    fetchSpy.mockImplementation(async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify(MOCK_RESPONSE), { status: 200 });
    });

    await templatesCommand({ q: 'chat', sort: 'popular', region: 'eu-west-1', limit: 5, offset: 10, json: true });

    const u = new URL(capturedUrl);
    expect(u.searchParams.get('q')).toBe('chat');
    expect(u.searchParams.get('sort')).toBe('popular');
    expect(u.searchParams.get('region')).toBe('eu-west-1');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('offset')).toBe('10');
  });

  it('exits 1 for invalid sort value', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await templatesCommand({ sort: 'invalid' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    errSpy.mockRestore();
  });

  it('prints "No templates found." when items is empty', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ items: [], total: 0, limit: 20, offset: 0 }), { status: 200 }),
    );
    await templatesCommand({});
    const output = logSpy.mock.calls.map((c: any[]) => String(c[0] ?? '')).join('\n');
    expect(output).toContain('No templates found.');
  });
});
