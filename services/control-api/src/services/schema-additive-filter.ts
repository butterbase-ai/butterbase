import type { DDLStatement } from './schema-differ.js';

/**
 * Admits only statements that create or add.
 *
 * Keyed on statement KIND rather than the `destructive` flag: diffSchema emits
 * `DROP INDEX` with `destructive: false, authorized: true`, so a flag-based
 * filter would let a fork's own index be dropped. The flags are advisory —
 * applyMigration does not honour them — so this is the only gate.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /^\s*DROP\s+TABLE\b/i,
  /^\s*DROP\s+INDEX\b/i,
  /^\s*DROP\s+VIEW\b/i,
  /^\s*TRUNCATE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i,
  /\bDROP\s+DEFAULT\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
];

export function filterAdditive(
  statements: DDLStatement[],
): { kept: DDLStatement[]; rejected: DDLStatement[] } {
  const kept: DDLStatement[] = [];
  const rejected: DDLStatement[] = [];
  for (const s of statements) {
    if (DESTRUCTIVE_PATTERNS.some((re) => re.test(s.sql))) rejected.push(s);
    else kept.push(s);
  }
  return { kept, rejected };
}
