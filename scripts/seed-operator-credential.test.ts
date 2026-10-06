import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  parseArgs,
  assertCredKeyFormat,
  seedOperator,
  DEFAULT_JOB_NAME,
  DEFAULT_JOB_INSTRUCTIONS,
  DEFAULT_JOB_INTERVAL_SECONDS,
} from './seed-operator-credential.js';
import { getOperatorCredential } from '../services/control-api/src/services/dashboard-agent/operator-credential.js';

process.env.OPERATOR_CRED_KEY = 'b'.repeat(64);

const pool = new pg.Pool({ connectionString: process.env.CONTROL_TEST_DATABASE_URL });

async function insertOrg(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO organizations (owner_id, name, personal, plan_id, credits_usd, auto_refill_enabled, account_status)
     VALUES ($1, $2, false, 'playground', 0, false, 'active')
     RETURNING id`,
    [randomUUID(), name],
  );
  return rows[0]!.id;
}

let orgId: string;

beforeEach(async () => {
  orgId = await insertOrg(`seed-operator-test-${randomUUID()}`);
});

afterAll(async () => {
  await pool.end();
});

describe('parseArgs', () => {
  it('parses a single org id positional argument', () => {
    expect(parseArgs(['abc-123'])).toEqual({ orgId: 'abc-123' });
  });

  it('throws a clear error when no org id is given', () => {
    expect(() => parseArgs([])).toThrow(/organization/i);
  });

  it('never accepts a service key as an argument', () => {
    // Only the first positional is consumed as orgId; anything else is not
    // treated as a secret input path. This test documents the contract: the
    // script has no flag for supplying the key on the command line.
    expect(parseArgs(['org-1'])).not.toHaveProperty('serviceKey');
  });
});

describe('assertCredKeyFormat', () => {
  const original = process.env.OPERATOR_CRED_KEY;
  afterAll(() => {
    process.env.OPERATOR_CRED_KEY = original;
  });

  it('passes when OPERATOR_CRED_KEY is 64 hex chars', () => {
    process.env.OPERATOR_CRED_KEY = 'a'.repeat(64);
    expect(() => assertCredKeyFormat()).not.toThrow();
  });

  it('throws clearly when OPERATOR_CRED_KEY is missing', () => {
    delete process.env.OPERATOR_CRED_KEY;
    expect(() => assertCredKeyFormat()).toThrow(/OPERATOR_CRED_KEY/);
  });

  it('throws clearly when OPERATOR_CRED_KEY is malformed (wrong length)', () => {
    process.env.OPERATOR_CRED_KEY = 'not-hex';
    expect(() => assertCredKeyFormat()).toThrow(/OPERATOR_CRED_KEY/);
  });

  it('throws clearly when OPERATOR_CRED_KEY is malformed (non-hex chars)', () => {
    process.env.OPERATOR_CRED_KEY = 'z'.repeat(64);
    expect(() => assertCredKeyFormat()).toThrow(/OPERATOR_CRED_KEY/);
  });

  it('never includes the bad value itself in the error message', () => {
    process.env.OPERATOR_CRED_KEY = 'super-secret-but-malformed-value';
    try {
      assertCredKeyFormat();
      throw new Error('expected assertCredKeyFormat to throw');
    } catch (err) {
      expect(String(err)).not.toContain('super-secret-but-malformed-value');
    }
  });
});

describe('seedOperator', () => {
  beforeEach(async () => {
    process.env.OPERATOR_CRED_KEY = 'b'.repeat(64);
  });

  it('seeds a credential and a job for a valid org', async () => {
    const result = await seedOperator(pool, orgId, 'bb_sk_example_key');

    expect(result.credential).toBe('created');
    expect(result.job).toBe('created');
    expect(result.orgId).toBe(orgId);

    expect(await getOperatorCredential(pool, orgId)).toBe('bb_sk_example_key');

    const job = await pool.query(
      `SELECT name, instructions, interval_seconds FROM dashboard_agent_operator_jobs WHERE organization_id = $1`,
      [orgId],
    );
    expect(job.rows).toHaveLength(1);
    expect(job.rows[0]).toEqual({
      name: DEFAULT_JOB_NAME,
      instructions: DEFAULT_JOB_INSTRUCTIONS,
      interval_seconds: DEFAULT_JOB_INTERVAL_SECONDS,
    });
  });

  it('is idempotent on re-run: no duplicate job, credential replaced cleanly, still decrypts', async () => {
    const first = await seedOperator(pool, orgId, 'bb_sk_first_key');
    expect(first.credential).toBe('created');
    expect(first.job).toBe('created');

    const second = await seedOperator(pool, orgId, 'bb_sk_second_key');
    expect(second.credential).toBe('replaced');
    expect(second.job).toBe('already-existed');

    // Exactly one job row — the UNIQUE (organization_id, name) constraint held.
    const jobs = await pool.query(
      `SELECT id FROM dashboard_agent_operator_jobs WHERE organization_id = $1 AND name = $2`,
      [orgId, DEFAULT_JOB_NAME],
    );
    expect(jobs.rows).toHaveLength(1);

    // Credential decrypts to the LATEST key, not a corrupted mix of old/new.
    expect(await getOperatorCredential(pool, orgId)).toBe('bb_sk_second_key');
  });

  it('fails clearly for a non-existent org and writes nothing', async () => {
    const fakeOrgId = randomUUID();
    await expect(seedOperator(pool, fakeOrgId, 'bb_sk_should_not_be_written')).rejects.toThrow(
      /organization/i,
    );

    expect(await getOperatorCredential(pool, fakeOrgId)).toBeNull();
    const jobs = await pool.query(
      `SELECT id FROM dashboard_agent_operator_jobs WHERE organization_id = $1`,
      [fakeOrgId],
    );
    expect(jobs.rows).toHaveLength(0);
  });

  it('fails clearly for a malformed (non-uuid) org id', async () => {
    await expect(seedOperator(pool, 'not-a-uuid', 'bb_sk_x')).rejects.toThrow(/organization/i);
  });
});

describe('secret hygiene', () => {
  it('never emits the service key to stdout or stderr on success or failure', async () => {
    const SECRET = 'bb_sk_never_logged_xyz789';
    const logSpy: string[] = [];
    const errSpy: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args: unknown[]) => {
      logSpy.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errSpy.push(args.map(String).join(' '));
    };

    try {
      // Success path.
      await seedOperator(pool, orgId, SECRET);
      // Failure path (non-existent org) — same secret, must not leak on error either.
      await seedOperator(pool, randomUUID(), SECRET).catch(() => {});
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    const allOutput = [...logSpy, ...errSpy].join('\n');
    expect(allOutput).not.toContain(SECRET);
  });
});
