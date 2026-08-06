#!/usr/bin/env tsx
/**
 * Seeds the operator credential + the default "sweep" job for one organization.
 *
 * This is the missing bootstrap step for the autonomous operator (Task I3):
 * `setOperatorCredential` has no other caller, and without a credential AND a
 * job row `runOperatorTurn` returns "no operator credential for org <id>" on
 * every wake. There is deliberately no HTTP route or MCP tool for this —
 * minting an operator credential must not be reachable over the network; it
 * is an operational, human-run step, same class of action as grant-credits.ts
 * or seed-dev-user.ts in this directory.
 *
 * Safety:
 *   - The service key is NEVER accepted as a CLI argument (would land in
 *     shell history and `ps` output). It must be supplied via the
 *     OPERATOR_SERVICE_KEY environment variable. Env vars do not appear in a
 *     plain `ps` listing (only argv does); prefer piping it in from a secrets
 *     manager or `read -s OPERATOR_SERVICE_KEY` over typing `export KEY=...`
 *     at an interactive prompt, which does land in shell history.
 *   - OPERATOR_CRED_KEY (the AES-256-GCM encryption key, 64 hex chars) is
 *     validated up front, before any DB write, so a bad key fails loudly at
 *     the start rather than silently at the first encrypt.
 *   - The key is never written to stdout/stderr, including on error paths.
 *
 * Idempotent: safe to re-run for the same org. The credential table is keyed
 * on organization_id (re-running replaces it); the job table has
 * UNIQUE (organization_id, name) (re-running leaves the existing job alone).
 * No pre-check-then-write race governs correctness — both properties come
 * from those constraints, enforced by the database itself.
 *
 * Usage:
 *   OPERATOR_CRED_KEY=<64 hex chars> OPERATOR_SERVICE_KEY=<service key> \
 *     tsx scripts/seed-operator-credential.ts <organization-id>
 *
 * Connection:
 *   Reads CONTROL_DB_URL from env, falling back to the local dev default
 *   (postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control).
 */
import pg from 'pg';
import { setOperatorCredential } from '../services/control-api/src/services/dashboard-agent/operator-credential.js';

export const DEFAULT_JOB_NAME = 'sweep';
export const DEFAULT_JOB_INSTRUCTIONS =
  'Review recent learnings, entities, and commitments. Flag anything at risk. Propose follow-ups.';
export const DEFAULT_JOB_INTERVAL_SECONDS = 600;

export function parseArgs(argv: string[]): { orgId: string } {
  const orgId = argv[0];
  if (!orgId) {
    throw new Error(
      'Usage: tsx scripts/seed-operator-credential.ts <organization-id>\n' +
        '  Service key must be supplied via the OPERATOR_SERVICE_KEY env var, never as an argument.',
    );
  }
  return { orgId };
}

/**
 * Validates OPERATOR_CRED_KEY up front so a bad key fails loudly and early —
 * before any DB write — rather than at the first encrypt inside
 * setOperatorCredential. Deliberately duplicates the 64-hex-char shape check
 * from operator-credential.ts's private `key()` (not exported, and this
 * script must not touch that file); this is a stricter regex (hex digits
 * only) than that function's plain length check, for a clearer error.
 */
export function assertCredKeyFormat(): void {
  const hex = process.env.OPERATOR_CRED_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'OPERATOR_CRED_KEY must be set to exactly 64 hexadecimal characters (32 bytes) ' +
        'before seeding an operator credential.',
    );
  }
}

export type SeedResult = {
  orgId: string;
  orgName: string;
  credential: 'created' | 'replaced';
  job: 'created' | 'already-existed';
};

export async function seedOperator(
  pool: pg.Pool,
  orgId: string,
  serviceKey: string,
): Promise<SeedResult> {
  let orgRes: pg.QueryResult<{ id: string; name: string }>;
  try {
    orgRes = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations WHERE id = $1`,
      [orgId],
    );
  } catch (err) {
    // Postgres 22P02 = invalid text representation for uuid — a malformed
    // org id, not a real DB error. Surface it as the same "org not found"
    // class of failure instead of a raw driver error.
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === '22P02') {
      throw new Error(`"${orgId}" is not a valid organization id.`);
    }
    throw err;
  }
  if (orgRes.rows.length === 0) {
    throw new Error(
      `No organization found with id ${orgId}. Refusing to seed a credential for an ` +
        `organization that does not exist — check for a typo.`,
    );
  }
  const org = orgRes.rows[0]!;

  // Pre-check is for the human-readable receipt ("created" vs "replaced")
  // only. The write itself is correct under a race regardless of what this
  // reads: setOperatorCredential's ON CONFLICT (organization_id) DO UPDATE
  // is idempotent either way.
  const existingCred = await pool.query(
    `SELECT 1 FROM dashboard_agent_operator_credentials WHERE organization_id = $1`,
    [orgId],
  );
  const credentialOutcome: SeedResult['credential'] =
    existingCred.rows.length > 0 ? 'replaced' : 'created';

  await setOperatorCredential(pool, orgId, serviceKey);

  // Atomic and race-free: ON CONFLICT DO NOTHING + RETURNING tells us exactly
  // whether this call inserted the row, leaning on the UNIQUE
  // (organization_id, name) constraint rather than a separate check.
  const jobInsert = await pool.query(
    `INSERT INTO dashboard_agent_operator_jobs (organization_id, name, instructions, interval_seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, name) DO NOTHING
     RETURNING id`,
    [orgId, DEFAULT_JOB_NAME, DEFAULT_JOB_INSTRUCTIONS, DEFAULT_JOB_INTERVAL_SECONDS],
  );
  const jobOutcome: SeedResult['job'] = jobInsert.rows.length > 0 ? 'created' : 'already-existed';

  return { orgId: org.id, orgName: org.name, credential: credentialOutcome, job: jobOutcome };
}

async function main() {
  // Validate the encryption key before touching argv parsing or the DB —
  // fail loudest, earliest failure first.
  assertCredKeyFormat();

  const { orgId } = parseArgs(process.argv.slice(2));

  const serviceKey = process.env.OPERATOR_SERVICE_KEY;
  if (!serviceKey) {
    throw new Error(
      'OPERATOR_SERVICE_KEY env var is required (the service key to encrypt and store). ' +
        'It is never accepted as a CLI argument.',
    );
  }

  const dbUrl =
    process.env.CONTROL_DB_URL ?? 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
  const pool = new pg.Pool({ connectionString: dbUrl });
  try {
    const result = await seedOperator(pool, orgId, serviceKey);
    console.log(`Organization:                ${result.orgName} (${result.orgId})`);
    console.log(`Operator credential:          ${result.credential}`);
    console.log(`Operator job "${DEFAULT_JOB_NAME}":            ${result.job}`);
  } finally {
    await pool.end();
  }
}

// Only run when executed directly (tsx scripts/seed-operator-credential.ts …),
// not when this module is imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Deliberately logs only err.message (or the error itself if it has no
    // message) — never any variable holding the service key.
    console.error(`seed-operator-credential failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
