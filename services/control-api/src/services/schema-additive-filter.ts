import type { DDLStatement } from './schema-differ.js';

/**
 * Admits only statements that create or add.
 *
 * Keyed on statement KIND rather than the `destructive` flag: diffSchema emits
 * `DROP INDEX` with `destructive: false, authorized: true`, so a flag-based
 * filter would let a fork's own index be dropped. The flags are advisory —
 * applyMigration does not honour them — so this is the only gate.
 *
 * Splits compound statements on `;` to catch destructive clauses hiding after
 * additive prefixes (e.g., `ALTER TABLE t ... SET DEFAULT 0; DROP TABLE users`).
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+INDEX\b/i,
  /\bDROP\s+VIEW\b/i,
  /\bTRUNCATE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bDROP\s+CONSTRAINT\b/i,
  /\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/i,
  /\bDROP\s+DEFAULT\b/i,
  /\bSET\s+NOT\s+NULL\b/i,
];

function isDestructive(sql: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(sql));
}

export function filterAdditive(
  statements: DDLStatement[],
): { kept: DDLStatement[]; rejected: DDLStatement[] } {
  const kept: DDLStatement[] = [];
  const rejected: DDLStatement[] = [];
  for (const s of statements) {
    // Split on `;` and check each sub-statement independently.
    // A compound statement is rejected if ANY sub-statement is destructive.
    const subStatements = s.sql.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
    const hasDestructive = subStatements.some((part) => isDestructive(part));
    if (hasDestructive) rejected.push(s);
    else kept.push(s);
  }
  return { kept, rejected };
}
