import { describe, it, expect } from 'vitest';
import { parseRedirects, matchRule, findMatchingRule } from './redirects-parser.js';

describe('parseRedirects', () => {
  it('parses the canonical SPA fallback rule', () => {
    const { rules, warnings } = parseRedirects('/*    /index.html   200\n');
    expect(rules).toEqual([{ from: '/*', to: '/index.html', status: 200 }]);
    expect(warnings).toEqual([]);
  });

  it('defaults status to 301 when omitted', () => {
    const { rules } = parseRedirects('/old /new\n');
    expect(rules).toEqual([{ from: '/old', to: '/new', status: 301 }]);
  });

  it('strips inline comments and skips blank lines', () => {
    const { rules } = parseRedirects(`
# A comment
/old /new 302   # trailing comment

# Another comment
/foo /bar 200
    `);
    expect(rules).toEqual([
      { from: '/old', to: '/new', status: 302 },
      { from: '/foo', to: '/bar', status: 200 },
    ]);
  });

  it('preserves rule order (first-match semantics)', () => {
    const { rules } = parseRedirects(`
/specific /one 200
/* /two 200
    `);
    expect(rules.map((r) => r.from)).toEqual(['/specific', '/*']);
  });

  it.each([200, 301, 302, 303, 307, 308])('accepts valid status %i', (status) => {
    const { rules } = parseRedirects(`/a /b ${status}\n`);
    expect(rules[0].status).toBe(status);
  });

  it.each(['418', '404', '500', 'banana'])(
    'rejects invalid status `%s` with a warning and skips the rule',
    (token) => {
      const { rules, warnings } = parseRedirects(`/a /b ${token}\n`);
      expect(rules).toEqual([]);
      expect(warnings).toHaveLength(1);
    },
  );

  it('warns on but skips lines with fewer than 2 tokens', () => {
    const { rules, warnings } = parseRedirects('/onetoken\n');
    expect(rules).toEqual([]);
    expect(warnings[0]).toMatch(/expected at least 2 tokens/);
  });

  it('rejects rules with `from` not starting with /', () => {
    const { rules, warnings } = parseRedirects('relative /target 301\n');
    expect(rules).toEqual([]);
    expect(warnings[0]).toMatch(/must start with \//);
  });

  it('skips rules with query/header matchers (advanced syntax)', () => {
    const { rules, warnings } = parseRedirects('/foo /bar status=200\n');
    expect(rules).toEqual([]);
    expect(warnings[0]).toMatch(/query\/header matchers/);
  });

  it('skips rules with named placeholders (not yet supported)', () => {
    const { rules, warnings } = parseRedirects('/users/:id /profile 301\n');
    expect(rules).toEqual([]);
    expect(warnings[0]).toMatch(/named placeholders/);
  });

  it('does NOT reject /* splat (the colon-free form)', () => {
    const { rules } = parseRedirects('/api/* /backend/:splat 301\n');
    expect(rules).toEqual([{ from: '/api/*', to: '/backend/:splat', status: 301 }]);
  });

  it('handles \\r\\n line endings', () => {
    const { rules } = parseRedirects('/a /b\r\n/c /d 302\r\n');
    expect(rules.map((r) => r.from)).toEqual(['/a', '/c']);
  });

  it('returns an empty result for empty input', () => {
    const { rules, warnings } = parseRedirects('');
    expect(rules).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('matchRule (exact)', () => {
  it('matches the exact path', () => {
    const rule = { from: '/about', to: '/about-us', status: 301 };
    expect(matchRule('/about', rule)).toBe('/about-us');
    expect(matchRule('/about/', rule)).toBeNull();
    expect(matchRule('/about/team', rule)).toBeNull();
    expect(matchRule('/other', rule)).toBeNull();
  });
});

describe('matchRule (splat)', () => {
  it('matches a /prefix/* pattern and substitutes :splat', () => {
    const rule = { from: '/api/*', to: '/backend/:splat', status: 301 };
    expect(matchRule('/api/users', rule)).toBe('/backend/users');
    expect(matchRule('/api/users/42', rule)).toBe('/backend/users/42');
    expect(matchRule('/api', rule)).toBe('/backend/'); // prefix-only match: empty splat
    expect(matchRule('/apix', rule)).toBeNull(); // not at a path boundary
    expect(matchRule('/other', rule)).toBeNull();
  });

  it('matches `/*` against everything and captures the entire path as splat', () => {
    const rule = { from: '/*', to: '/index.html', status: 200 };
    expect(matchRule('/', rule)).toBe('/index.html');
    expect(matchRule('/history', rule)).toBe('/index.html');
    expect(matchRule('/deep/nested/route', rule)).toBe('/index.html');
  });

  it('substitutes :splat multiple times in `to`', () => {
    const rule = { from: '/files/*', to: '/store/:splat?backup=:splat', status: 200 };
    expect(matchRule('/files/foo.txt', rule)).toBe('/store/foo.txt?backup=foo.txt');
  });

  it('to without :splat keeps a literal target regardless of suffix', () => {
    const rule = { from: '/old/*', to: '/index.html', status: 200 };
    expect(matchRule('/old/anything', rule)).toBe('/index.html');
    expect(matchRule('/old', rule)).toBe('/index.html');
  });
});

describe('findMatchingRule', () => {
  it('returns null when no rule matches', () => {
    const rules = [{ from: '/a', to: '/b', status: 301 }];
    expect(findMatchingRule('/c', rules)).toBeNull();
  });

  it('returns the FIRST matching rule (order matters)', () => {
    const rules = [
      { from: '/specific', to: '/exact', status: 200 },
      { from: '/*', to: '/index.html', status: 200 },
    ];
    const m1 = findMatchingRule('/specific', rules);
    expect(m1?.resolvedTo).toBe('/exact');
    const m2 = findMatchingRule('/anything', rules);
    expect(m2?.resolvedTo).toBe('/index.html');
  });

  it('returns the resolved target with splat substitution applied', () => {
    const rules = [{ from: '/api/*', to: '/v2/:splat', status: 301 }];
    const m = findMatchingRule('/api/users/42', rules);
    expect(m?.resolvedTo).toBe('/v2/users/42');
    expect(m?.rule.status).toBe(301);
  });
});
