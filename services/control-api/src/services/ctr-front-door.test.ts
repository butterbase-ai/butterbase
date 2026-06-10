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
});
