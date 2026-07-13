import { describe, it, expect } from 'vitest';
import { extractClassName, BundlerError, buildBundle } from './do-bundler.js';

describe('extractClassName', () => {
  it('returns the single exported class name', () => {
    const src = `
      export class ChatRoom {
        async fetch(req) { return new Response('ok'); }
      }
    `;
    expect(extractClassName(src)).toBe('ChatRoom');
  });

  it('throws when no class is exported', () => {
    const src = `export const foo = 1;`;
    expect(() => extractClassName(src)).toThrow(BundlerError);
  });

  it('throws when multiple classes are exported', () => {
    const src = `
      export class A {}
      export class B {}
    `;
    expect(() => extractClassName(src)).toThrow(BundlerError);
  });

  it('throws when source imports from outside the Workers runtime', () => {
    const src = `
      import { z } from 'zod';
      export class C {}
    `;
    expect(() => extractClassName(src)).toThrow(BundlerError);
  });

  it('allows imports of cloudflare:* modules', () => {
    const src = `
      import { DurableObject } from 'cloudflare:workers';
      export class C extends DurableObject {}
    `;
    expect(extractClassName(src)).toBe('C');
  });

  it("rejects 'export default class X {}' with EXPORT_DEFAULT_NOT_SUPPORTED", () => {
    const src = `export default class MyDO {}`;
    expect(() => extractClassName(src)).toThrow(
      expect.objectContaining({ code: 'EXPORT_DEFAULT_NOT_SUPPORTED' }),
    );
  });

  it("rejects anonymous 'export default class {}' with EXPORT_DEFAULT_NOT_SUPPORTED", () => {
    const src = `export default class {}`;
    expect(() => extractClassName(src)).toThrow(
      expect.objectContaining({ code: 'EXPORT_DEFAULT_NOT_SUPPORTED' }),
    );
  });
});

describe('buildBundle', () => {
  it('concatenates classes and emits a dispatch handler with bindings', () => {
    const result = buildBundle([
      { name: 'chat-room',   code: 'export class ChatRoom {}',     access_mode: 'public' },
      { name: 'leaderboard', code: 'export class Leaderboard {}',  access_mode: 'authenticated' },
    ]);

    // The bundle must include both classes (transpiled output preserves the
    // `export class X` form).
    expect(result.bundle).toMatch(/export\s+class\s+ChatRoom\b/);
    expect(result.bundle).toMatch(/export\s+class\s+Leaderboard\b/);

    // Routes table maps URL name to binding name + access_mode.
    expect(result.bundle).toContain("'chat-room':");
    expect(result.bundle).toContain("'leaderboard':");
    expect(result.bundle).toContain("'CHAT_ROOM'");
    expect(result.bundle).toContain("'LEADERBOARD'");

    // Default fetch handler exists.
    expect(result.bundle).toMatch(/export\s+default\s*\{[\s\S]*async\s+fetch/);

    expect(result.bindingNames).toEqual(['CHAT_ROOM', 'LEADERBOARD']);
  });

  it('strips TypeScript-only syntax (private, type annotations, parameter properties)', () => {
    const tsSource = `
      export class ChatRoom {
        private sockets: Set<WebSocket> = new Set();
        constructor(public state: DurableObjectState, public env: Record<string, string>) {}
        async fetch(req: Request): Promise<Response> {
          return new Response('ok');
        }
      }
    `;
    const result = buildBundle([{ name: 'chat-room', code: tsSource, access_mode: 'public' }]);
    // No TS-only keywords should survive into the JS bundle.
    expect(result.bundle).not.toMatch(/\bprivate\s+sockets\b/);
    expect(result.bundle).not.toMatch(/:\s*Set<WebSocket>/);
    expect(result.bundle).not.toMatch(/:\s*Promise<Response>/);
    // The class itself must remain exported under its original name.
    expect(result.bundle).toMatch(/export\s+class\s+ChatRoom\b/);
  });

  it('hoists and dedupes cloudflare:* imports across multiple classes', () => {
    const a = `
      import { DurableObject } from 'cloudflare:workers';
      export class A extends DurableObject {}
    `;
    const b = `
      import { DurableObject } from 'cloudflare:workers';
      export class B extends DurableObject {}
    `;
    const result = buildBundle([
      { name: 'a', code: a, access_mode: 'public' },
      { name: 'b', code: b, access_mode: 'public' },
    ]);
    const matches = result.bundle.match(/import\s*\{[^}]*\bDurableObject\b[^}]*\}\s*from\s*['"]cloudflare:workers['"]/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('rejects more than 5 classes', () => {
    const cls = (i: number) => ({ name: `c${i}`, code: `export class C${i} {}`, access_mode: 'public' as const });
    const six = [0,1,2,3,4,5].map(cls);
    expect(() => buildBundle(six)).toThrow(BundlerError);
  });

  it('rejects total bundle size > 10 MB', () => {
    const big = 'export class Big {}\n'.repeat(600_000); // ~12 MB
    expect(() => buildBundle([{ name: 'big', code: big, access_mode: 'public' }])).toThrow(BundlerError);
  });

  it('rejects a class with an invalid name (space in name)', () => {
    expect(() =>
      buildBundle([{ name: 'foo bar', code: 'export class Foo {}', access_mode: 'public' }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_NAME' }));
  });

  it('rejects a class with an invalid access_mode', () => {
    expect(() =>
      buildBundle([{ name: 'my-do', code: 'export class MyDo {}', access_mode: 'admin' as any }]),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACCESS_MODE' }));
  });
});

describe('bundler butterbase.ctx helper', () => {
  it('prepends a `butterbase` helper with ctx() to every bundle', () => {
    const { bundle } = buildBundle([
      { name: 'my-do', code: 'export class MyDo { async fetch(req) { return new Response("ok"); } }', access_mode: 'public' },
    ]);
    expect(bundle).toContain('const butterbase');
    expect(bundle).toMatch(/butterbase\s*=\s*{/);
    expect(bundle).toMatch(/ctx\s*[:(]/);
  });

  it("scrubs DO_INVOKER_TOKEN and DO_INVOKER_URL from ctx.env", () => {
    const { bundle } = buildBundle([
      { name: 'my-do', code: 'export class MyDo { async fetch(req) { return new Response("ok"); } }', access_mode: 'public' },
    ]);
    expect(bundle).toMatch(/delete\s+\w+\.DO_INVOKER_TOKEN/);
    expect(bundle).toMatch(/delete\s+\w+\.DO_INVOKER_URL/);
  });

  it("scrubs BUTTERBASE_INTERNAL_FN_KEY from ctx.env (user code should use ctx.invoke)", () => {
    const { bundle } = buildBundle([
      { name: 'my-do', code: 'export class MyDo { async fetch(req) { return new Response("ok"); } }', access_mode: 'public' },
    ]);
    expect(bundle).toMatch(/delete\s+\w+\.BUTTERBASE_INTERNAL_FN_KEY/);
  });

  it('emits an invokeDO that POSTs to DO_INVOKER_URL/invoke with the right headers', () => {
    const { bundle } = buildBundle([
      { name: 'my-do', code: 'export class MyDo { async fetch(req) { return new Response("ok"); } }', access_mode: 'public' },
    ]);
    expect(bundle).toContain('/invoke');
    expect(bundle).toContain('x-butterbase-app');
    expect(bundle).toContain('x-butterbase-class');
    expect(bundle).toContain('x-butterbase-instance');
    expect(bundle).toContain('x-butterbase-internal-caller');
    expect(bundle).toContain('x-butterbase-loop-depth');
  });

  it("does NOT modify user class source (opt-in helper — old DOs still work)", () => {
    const userCode = 'export class MyDo { async fetch(req) { return new Response("ok"); } }';
    const { bundle } = buildBundle([{ name: 'my-do', code: userCode, access_mode: 'public' }]);
    expect(bundle).toContain('class MyDo');
    expect(bundle).not.toMatch(/class __User_?MyDo/);
  });
});

describe('bundler generated fetch — dispatch branch', () => {
  it('emits a fetch handler that routes internal.butterbase/_dispatch to the DO namespace', () => {
    const { bundle } = buildBundle([
      { name: 'support-ticket-do', code: 'export class SupportTicketDo { async fetch() { return new Response("ok"); } }', access_mode: 'public' },
    ]);
    expect(bundle).toContain("'internal.butterbase'");
    expect(bundle).toContain('/_dispatch/');
    expect(bundle).toContain('idFromName');
  });

  it('preserves the existing /_do/ public path exactly', () => {
    const { bundle } = buildBundle([
      { name: 'chat-room', code: 'export class ChatRoom { async fetch() { return new Response("ok"); } }', access_mode: 'authenticated' },
    ]);
    expect(bundle).toContain('_do');
    expect(bundle).toContain('checkAuth');
    expect(bundle).toContain('ROUTES');
  });
});
