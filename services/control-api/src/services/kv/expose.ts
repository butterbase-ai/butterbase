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
    // compileRule emits the template as escaped regex source (e.g. `\{user\.id\}`),
    // so the matcher here must match those literal backslashes too: `\\\{user\\.id\\\}`.
    const tpl = `\\\\\\{${name.replace(/\./g, '\\\\\\.')}\\\\\\}`;
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

// Redis I/O layer for rule storage.

export interface RedisClientLike {
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, fields: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

function metaKey(appId: string): string {
  return `{${appId}}:_meta:expose`;
}

interface StoredRule {
  read: Role;
  write: Role;
  order: number;
}

export async function loadRules(c: RedisClientLike, appId: string): Promise<CompiledRule[]> {
  const raw = await c.hgetall(metaKey(appId));
  const rules: CompiledRule[] = [];
  for (const [pattern, json] of Object.entries(raw)) {
    const stored = JSON.parse(json) as StoredRule;
    rules.push(compileRule({ pattern, read: stored.read, write: stored.write }, stored.order));
  }
  return rules;
}

export async function saveRule(
  c: RedisClientLike,
  appId: string,
  rule: RuleSource,
  declarationOrder: number,
): Promise<void> {
  const stored: StoredRule = { read: rule.read, write: rule.write, order: declarationOrder };
  await c.hset(metaKey(appId), rule.pattern, JSON.stringify(stored));
}

export async function deleteRule(c: RedisClientLike, appId: string, pattern: string): Promise<boolean> {
  const n = await c.hdel(metaKey(appId), [pattern]);
  return n > 0;
}

export async function nextDeclarationOrder(c: RedisClientLike, appId: string): Promise<number> {
  const raw = await c.hgetall(metaKey(appId));
  let max = -1;
  for (const json of Object.values(raw)) {
    const stored = JSON.parse(json) as StoredRule;
    if (stored.order > max) max = stored.order;
  }
  return max + 1;
}

/**
 * Delete all expose rules for an app. Used by the bulk-replace endpoint.
 * The RedisClientLike interface does not include DEL, so we accept a client
 * that also exposes a `del` method (the full RedisClient satisfies this).
 */
export async function clearRules(
  c: RedisClientLike & { del(keys: string[]): Promise<number> },
  appId: string,
): Promise<void> {
  await c.del([metaKey(appId)]);
}

/**
 * Replace all expose rules for an app atomically (clear then save).
 * Accepts an optional declarationOrder seed so callers can start from 0.
 */
export async function replaceRules(
  c: RedisClientLike & { del(keys: string[]): Promise<number> },
  appId: string,
  rules: RuleSource[],
): Promise<void> {
  await c.del([metaKey(appId)]);
  for (let i = 0; i < rules.length; i++) {
    await saveRule(c, appId, rules[i]!, i);
  }
}
