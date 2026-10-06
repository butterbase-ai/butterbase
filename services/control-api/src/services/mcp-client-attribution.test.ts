import { describe, it, expect } from 'vitest';
import { slugifyClientName, mcpAttributionParams } from './mcp-client-attribution.js';

describe('slugifyClientName', () => {
  it('slugifies the client names we actually see in production', () => {
    expect(slugifyClientName('Cursor')).toBe('cursor');
    expect(slugifyClientName('Qoder')).toBe('qoder');
    expect(slugifyClientName('Codex')).toBe('codex');
    expect(slugifyClientName('Visual Studio Code')).toBe('visual-studio-code');
    expect(slugifyClientName('Claude Code (butterbase)')).toBe('claude-code-butterbase');
    expect(slugifyClientName('lingma-ide')).toBe('lingma-ide');
  });

  it('returns null when no usable slug survives', () => {
    expect(slugifyClientName(null)).toBeNull();
    expect(slugifyClientName(undefined)).toBeNull();
    expect(slugifyClientName('')).toBeNull();
    expect(slugifyClientName('   ')).toBeNull();
    expect(slugifyClientName('!!!')).toBeNull();
  });

  it('strips characters that would break the header or forge UTM keys', () => {
    // client_name is attacker-controlled: anyone can POST /oauth/register.
    const injected = slugifyClientName('evil\r\nX-Admin: 1');
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected).toBe('evil-x-admin-1');

    // '&' and '=' would otherwise let a registered client inject extra keys
    // into the composed `utm_source=..&utm_campaign=..` string.
    expect(slugifyClientName('a&utm_campaign=hijack')).toBe('a-utm-campaign-hijack');
    expect(slugifyClientName('<script>alert(1)</script>')).toBe('script-alert-1-script');
  });

  it('caps length and never ends on a dash', () => {
    const slug = slugifyClientName('x'.repeat(300));
    expect(slug!.length).toBeLessThanOrEqual(40);

    // A cut that lands mid-separator must not leave a trailing dash.
    const cut = slugifyClientName(`${'a'.repeat(39)} tail`);
    expect(cut).not.toMatch(/-$/);
  });

  it('only ever emits [a-z0-9-]', () => {
    for (const name of ['Ünïcodé Çlient', '日本語クライアント', 'a/b\\c:d', "quote'and\"double"]) {
      const slug = slugifyClientName(name);
      if (slug !== null) expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('mcpAttributionParams', () => {
  it('prefixes the source so MCP clients group and cannot collide with a marketing source', () => {
    expect(mcpAttributionParams('Cursor')).toEqual({
      utm_source: 'mcp-cursor',
      utm_medium: 'mcp',
      utm_campaign: 'mcp-oauth',
    });
  });

  it('returns null rather than a bare prefix when the name yields nothing', () => {
    expect(mcpAttributionParams('!!!')).toBeNull();
    expect(mcpAttributionParams(null)).toBeNull();
  });
});
