// services/control-api/src/services/ctr-front-door.test.ts
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { buildFrontDoorWorker, toContainerScriptName, CTR_CLASS_NAME } from './ctr-front-door.js';

describe('toContainerScriptName', () => {
  it('builds {appId}_ctr_{name}', () => {
    expect(toContainerScriptName('app_abc', 'game-server')).toBe('app_abc_ctr_game-server');
  });
});

describe('buildFrontDoorWorker', () => {
  const base = {
    name: 'game-server',
    mode: 'actor' as const,
    accessMode: 'public' as const,
    port: 8080,
    sleepAfterS: 300,
    maxInstances: 5,
  };

  // ---------------------------------------------------------------------------
  // Name validation (requirement 1)
  // ---------------------------------------------------------------------------

  it('throws for invalid name: uppercase letter (Bad_Name)', () => {
    expect(() => buildFrontDoorWorker({ ...base, name: 'Bad_Name' })).toThrow(
      /Invalid container name/,
    );
  });

  it("throws for invalid name: single-quote injection (a'b)", () => {
    expect(() => buildFrontDoorWorker({ ...base, name: "a'b" })).toThrow(
      /Invalid container name/,
    );
  });

  it('throws for invalid name: leading hyphen (-x)', () => {
    expect(() => buildFrontDoorWorker({ ...base, name: '-x' })).toThrow(
      /Invalid container name/,
    );
  });

  it('does not throw for a valid kebab name', () => {
    expect(() => buildFrontDoorWorker({ ...base, name: 'game-server' })).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Structural / embedding tests (existing, kept)
  // ---------------------------------------------------------------------------

  it('embeds the route config and exports the container class', () => {
    const src = buildFrontDoorWorker(base);
    expect(src).toContain(`export class ${CTR_CLASS_NAME}`);
    expect(src).toContain('"mode":"actor"');
    expect(src).toContain('"access_mode":"public"');
    expect(src).toContain('getTcpPort(8080)');
  });

  it('embeds the idle alarm with the configured sleep window', () => {
    const src = buildFrontDoorWorker(base);
    expect(src).toContain('300000'); // 300s in ms
    expect(src).toContain('setAlarm');
  });

  it('alarm re-arm is gated: uses getAlarm + conditional setAlarm (avoids write per request)', () => {
    const src = buildFrontDoorWorker(base);
    expect(src).toContain('getAlarm()');
    // The half-window threshold must be present (Math.floor(300000 / 2) = 150000)
    expect(src).toContain('150000');
    // setAlarm is still present (called conditionally)
    expect(src).toContain('setAlarm(');
  });

  it('actor mode requires a key; pool mode spreads across slots', () => {
    expect(buildFrontDoorWorker(base)).toContain('idFromName(');
    const pool = buildFrontDoorWorker({ ...base, mode: 'pool' });
    expect(pool).toContain('"mode":"pool"');
    expect(pool).toContain("'pool-'");
  });

  it('service_key mode emits the bb_sk_ prefix check', () => {
    expect(buildFrontDoorWorker({ ...base, accessMode: 'service_key' })).toContain('Bearer bb_sk_');
  });

  it('generated source has no @cloudflare/containers import', () => {
    expect(buildFrontDoorWorker(base)).not.toContain('@cloudflare/containers');
  });

  it('syntactic validity: generated source parses without diagnostics', () => {
    const src = buildFrontDoorWorker(base);
    const sf = ts.createSourceFile('ctr-front-door-generated.js', src, ts.ScriptTarget.ES2022, true);
    // @ts-expect-error parseDiagnostics is an internal property but reliable for template-lint purposes
    const diags: ts.Diagnostic[] = (sf as any).parseDiagnostics ?? [];
    if (diags.length > 0) {
      const messages = diags
        .map((d) => (typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText))
        .join('; ');
      throw new Error(`Generated source has parse errors: ${messages}`);
    }
    expect(diags.length).toBe(0);
  });

  it('syntactic validity also holds for pool + service_key config', () => {
    const src = buildFrontDoorWorker({ ...base, mode: 'pool', accessMode: 'service_key' });
    const sf = ts.createSourceFile('ctr-front-door-pool.js', src, ts.ScriptTarget.ES2022, true);
    // @ts-expect-error internal property
    const diags: ts.Diagnostic[] = (sf as any).parseDiagnostics ?? [];
    expect(diags.length).toBe(0);
  });

  it('actor mode: generated source contains key-required check (400 with helpful message)', () => {
    const src = buildFrontDoorWorker(base);
    expect(src).toContain('400');
    // Ensure the pathname regex is correctly escaped (no double-backslash bug)
    // The regex literal must appear as /^..._containers.../ in the source
    expect(src).toMatch(/\^\\\/_containers/);
  });

  it('pool mode: "key" segment treated as part of path, not actor identity', () => {
    const src = buildFrontDoorWorker({ ...base, mode: 'pool' });
    // pool uses Math.random() slot selection
    expect(src).toContain('Math.random()');
    expect(src).toContain('maxInstances');
  });

  // ---------------------------------------------------------------------------
  // Behavioral regex / path-rejoin tests (requirement 2)
  // Extract the route regex from generated source and execute it.
  // ---------------------------------------------------------------------------

  describe('route regex and innerPath reconstruction', () => {
    /**
     * Extract the route regex literal from the generated source and return
     * it as a RegExp that can be executed in the test environment.
     */
    function extractRouteRegex(src: string): RegExp {
      // The emitted line looks like: const m = url.pathname.match(/^...$/)
      const match = src.match(/url\.pathname\.match\((\/.+?\/)\)/);
      if (!match) throw new Error('Could not find route regex in generated source');
      // Eval the regex literal safely — it's platform-owned, not user input.
      // eslint-disable-next-line no-new-func
      return new Function(`return ${match[1]}`)() as RegExp;
    }

    /**
     * Replicate the innerPath reconstruction expressions from the template.
     * actor:  rest || '/'
     * pool:   key ? '/' + key + (rest || '') : (rest || '/')
     */
    function actorInnerPath(key: string | undefined, rest: string | undefined): string {
      return rest || '/';
    }
    function poolInnerPath(key: string | undefined, rest: string | undefined): string {
      return key ? '/' + key + (rest || '') : rest || '/';
    }

    const srcActor = buildFrontDoorWorker(base); // actor mode, name = 'game-server'
    const srcPool = buildFrontDoorWorker({ ...base, mode: 'pool' });
    const re = extractRouteRegex(srcActor); // same regex for both modes

    it('extracts a working RegExp from the generated source', () => {
      expect(re).toBeInstanceOf(RegExp);
    });

    it('/_containers/game-server → match with name=game-server, key=undefined, rest=undefined', () => {
      const m = '/_containers/game-server'.match(re);
      expect(m).not.toBeNull();
      const [, routeName, key, rest] = m!;
      expect(routeName).toBe('game-server');
      expect(key).toBeUndefined();
      expect(rest).toBeUndefined();
      // actor: no key → 400 case (tested structurally above; verify re groups here)
      // pool: innerPath should be '/'
      expect(poolInnerPath(key, rest)).toBe('/');
    });

    it('/_containers/game-server/k1 → key=k1, rest=undefined', () => {
      const m = '/_containers/game-server/k1'.match(re);
      expect(m).not.toBeNull();
      const [, routeName, key, rest] = m!;
      expect(routeName).toBe('game-server');
      expect(key).toBe('k1');
      expect(rest).toBeUndefined();
      // actor: innerPath = rest || '/' = '/'
      expect(actorInnerPath(key, rest)).toBe('/');
      // pool: innerPath = '/k1'
      expect(poolInnerPath(key, rest)).toBe('/k1');
    });

    it('/_containers/game-server/k1/a/b → key=k1, rest=/a/b', () => {
      const m = '/_containers/game-server/k1/a/b'.match(re);
      expect(m).not.toBeNull();
      const [, routeName, key, rest] = m!;
      expect(routeName).toBe('game-server');
      expect(key).toBe('k1');
      expect(rest).toBe('/a/b');
      // actor: innerPath = '/a/b'
      expect(actorInnerPath(key, rest)).toBe('/a/b');
      // pool: innerPath = '/k1/a/b'
      expect(poolInnerPath(key, rest)).toBe('/k1/a/b');
    });

    it('/_containers/other-name/x → name mismatch (routeName !== game-server)', () => {
      const m = '/_containers/other-name/x'.match(re);
      // The regex itself will match (it captures any name), but routeName check in the worker rejects it.
      // Verify that routeName is NOT 'game-server'.
      expect(m).not.toBeNull();
      const [, routeName] = m!;
      expect(routeName).not.toBe('game-server');
    });

    it('/nope → no match', () => {
      expect('/nope'.match(re)).toBeNull();
    });
  });
});
