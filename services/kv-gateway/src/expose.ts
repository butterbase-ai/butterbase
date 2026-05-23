// Pattern compiler + matcher + conflict detector for kv.expose().
// Pure logic — no Redis, no I/O. The worker layer reads/writes the rule set
// in Redis and calls these helpers.

export type Role = 'public' | 'authed' | 'owner' | 'deny';

export interface RuleSource {
  pattern: string;
  read: Role;
  write: Role;
}

export interface CompiledRule extends RuleSource {
  regex: RegExp;
  literalPrefixLen: number;   // characters before the first wildcard/template, for tiebreak
  declarationOrder: number;   // insertion order, for tiebreak
}

// Convert a pattern to a regex. Recognised tokens:
//   `*`  → matches one segment (no `:` inside)
//   `**` → matches any number of nested segments
//   `{user.id}` / `{user.role}` → preserved as literal `\{user\.id\}` in the regex source;
//     the worker substitutes the actual JWT claim value at request time before testing.
//
// All other characters are escaped.
export function compileRule(src: RuleSource, declarationOrder: number): CompiledRule {
  const tokens: string[] = [];
  let i = 0;
  let literalPrefixLen = 0;
  let sawWildcardOrTemplate = false;
  while (i < src.pattern.length) {
    const ch = src.pattern[i];
    if (src.pattern.startsWith('**', i)) {
      tokens.push('.*');
      i += 2;
      sawWildcardOrTemplate = true;
    } else if (ch === '*') {
      tokens.push('[^:]+');
      i += 1;
      sawWildcardOrTemplate = true;
    } else if (ch === '{') {
      const end = src.pattern.indexOf('}', i);
      if (end === -1) throw new Error(`unterminated template in pattern: ${src.pattern}`);
      const tpl = src.pattern.slice(i, end + 1);   // e.g. "{user.id}"
      tokens.push(tpl.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
      i = end + 1;
      sawWildcardOrTemplate = true;
    } else {
      tokens.push(ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'));
      if (!sawWildcardOrTemplate) literalPrefixLen += 1;
      i += 1;
    }
  }
  const regex = new RegExp('^' + tokens.join('') + '$');
  return { ...src, regex, literalPrefixLen, declarationOrder };
}

// Substitutes template values into a CompiledRule's regex and tests against the key.
// claims is { 'user.id'?: string, 'user.role'?: string } — keys exactly as templates appear.
export function substituteAndTest(rule: CompiledRule, key: string, claims: Record<string, string>): boolean {
  let src = rule.regex.source;
  for (const [name, value] of Object.entries(claims)) {
    const escaped = value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const tpl = `\\{${name.replace(/\./g, '\\.')}\\}`;
    src = src.replace(new RegExp(tpl, 'g'), escaped);
  }
  return new RegExp(src).test(key);
}

// Picks the matching rule by longest literal prefix, ties broken by declarationOrder.
// Does NOT do template substitution — caller does that for "owner" enforcement.
export function matchRules(rules: CompiledRule[], key: string): CompiledRule | null {
  const candidates = rules.filter((r) => r.regex.test(key));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    b.literalPrefixLen - a.literalPrefixLen ||
    a.declarationOrder - b.declarationOrder,
  );
  return candidates[0];
}

// Returns the conflicting rule (the existing one) when `candidate` cannot be added,
// or null when it's safe. Two rules conflict iff they have identical patterns AND
// different (read, write) tuples. Adding an exact duplicate is idempotent.
export function detectConflict(existing: CompiledRule[], candidate: CompiledRule): CompiledRule | null {
  for (const r of existing) {
    if (r.pattern === candidate.pattern) {
      if (r.read === candidate.read && r.write === candidate.write) return null;
      return r;
    }
  }
  return null;
}
