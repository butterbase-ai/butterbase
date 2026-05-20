// Integration tests for notification preferences against the live local
// control DB. Requires the docker-compose stack (control-plane-db) and a
// pre-applied migration 069.
//
// Test isolation: each test creates a fresh platform_user with a random
// UUID, exercises against it, then relies on ON DELETE CASCADE (or simply
// leaves the row — there is no global state we share between tests).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  isSilenced,
  createActionToken,
  consumeActionToken,
  snoozeFunctionFor24h,
  muteFunction,
  unsubscribeFromTemplate,
  generateToken,
} from '../services/notification-prefs.service.js';

const CONNECTION = process.env.TEST_CONTROL_DB_URL
  || 'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';

let pool: pg.Pool;

async function makeUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO platform_users (id, email) VALUES ($1, $2)`,
    [id, `${id}@test.local`],
  );
  return id;
}

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: CONNECTION });
  // Sanity-check migration is applied.
  await pool.query('SELECT 1 FROM notification_action_tokens LIMIT 0');
});

afterAll(async () => {
  await pool.end();
});

describe('notification-prefs: isSilenced', () => {
  it('returns false by default (no prefs, no snoozes)', async () => {
    const userId = await makeUser();
    expect(await isSilenced(pool, userId, 'function_failed')).toBe(false);
  });

  it('returns true when the template is in unsubscribed_templates', async () => {
    const userId = await makeUser();
    await unsubscribeFromTemplate(pool, userId, 'function_failed');
    expect(await isSilenced(pool, userId, 'function_failed')).toBe(true);
    // Other templates still send.
    expect(await isSilenced(pool, userId, 'deployment_failed')).toBe(false);
  });

  it('returns true when a function snooze is active and we pass functionId', async () => {
    const userId = await makeUser();
    const fnId = 'fn_' + randomUUID().slice(0, 8);
    await snoozeFunctionFor24h(pool, userId, fnId);
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: fnId })).toBe(true);
    // Different function isn't silenced.
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: 'fn_other' })).toBe(false);
  });

  it('returns false for an expired snooze', async () => {
    const userId = await makeUser();
    const fnId = 'fn_expired';
    // Insert a snooze that already ended.
    await pool.query(
      `INSERT INTO notification_snoozes (user_id, scope_type, scope_id, snoozed_until)
       VALUES ($1, 'function', $2, now() - interval '1 hour')`,
      [userId, fnId],
    );
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: fnId })).toBe(false);
  });

  it('muteFunction silences indefinitely (until year 9999)', async () => {
    const userId = await makeUser();
    const fnId = 'fn_muted';
    await muteFunction(pool, userId, fnId);
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: fnId })).toBe(true);
    const r = await pool.query<{ snoozed_until: Date }>(
      `SELECT snoozed_until FROM notification_snoozes WHERE user_id = $1 AND scope_id = $2`,
      [userId, fnId],
    );
    expect(r.rows[0].snoozed_until.getFullYear()).toBe(9999);
  });

  it('digest_enabled silences function_failed + deployment_failed but not other templates', async () => {
    const userId = await makeUser();
    await pool.query(
      `INSERT INTO notification_preferences (user_id, digest_enabled) VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET digest_enabled = true`,
      [userId],
    );
    // Digest-covered templates are silenced.
    expect(await isSilenced(pool, userId, 'function_failed')).toBe(true);
    expect(await isSilenced(pool, userId, 'deployment_failed')).toBe(true);
    // Action-required templates still go through.
    expect(await isSilenced(pool, userId, 'payment_failed')).toBe(false);
    expect(await isSilenced(pool, userId, 'soft_locked')).toBe(false);
  });

  it('fail-open: returns false if the DB query throws', async () => {
    // Pass a broken pool to force a query error.
    const broken = { query: async () => { throw new Error('DB down'); } } as unknown as pg.Pool;
    const warnings: unknown[] = [];
    const result = await isSilenced(
      broken,
      'whatever',
      'function_failed',
      {},
      { warn: (p) => { warnings.push(p); } },
    );
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe('notification-prefs: action tokens', () => {
  it('generateToken produces unguessable URL-safe strings', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 base64url chars
    // Two consecutive tokens are not equal.
    expect(generateToken()).not.toBe(t);
  });

  it('createActionToken stores token and consumeActionToken redeems exactly once', async () => {
    const userId = await makeUser();
    const fnId = 'fn_token_test';
    const token = await createActionToken(pool, {
      userId,
      action: 'snooze_function_24h',
      payload: { functionId: fnId },
    });

    const first = await consumeActionToken(pool, token);
    expect(first).not.toBeNull();
    expect(first!.userId).toBe(userId);
    expect(first!.action).toBe('snooze_function_24h');
    expect(first!.payload.functionId).toBe(fnId);

    // Second consume returns null — single-use.
    const second = await consumeActionToken(pool, token);
    expect(second).toBeNull();
  });

  it('consumeActionToken returns null for unknown tokens', async () => {
    const r = await consumeActionToken(pool, generateToken());
    expect(r).toBeNull();
  });

  it('consumeActionToken returns null for expired tokens', async () => {
    const userId = await makeUser();
    const token = generateToken();
    await pool.query(
      `INSERT INTO notification_action_tokens (token, user_id, action, payload, expires_at)
       VALUES ($1, $2, 'mute_function', $3::jsonb, now() - interval '1 minute')`,
      [token, userId, JSON.stringify({ functionId: 'fn_x' })],
    );
    expect(await consumeActionToken(pool, token)).toBeNull();
  });
});

describe('notification-prefs: end-to-end token → silence', () => {
  it('snooze token redemption results in subsequent isSilenced=true', async () => {
    const userId = await makeUser();
    const fnId = 'fn_e2e_snooze';

    // Start: not silenced.
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: fnId })).toBe(false);

    // Mint + consume a snooze token (simulating the email-link click).
    const token = await createActionToken(pool, {
      userId,
      action: 'snooze_function_24h',
      payload: { functionId: fnId },
    });
    const consumed = await consumeActionToken(pool, token);
    expect(consumed).not.toBeNull();
    await snoozeFunctionFor24h(pool, consumed!.userId, String(consumed!.payload.functionId));

    // Now silenced for this function — but not for a different function.
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: fnId })).toBe(true);
    expect(await isSilenced(pool, userId, 'function_failed', { functionId: 'fn_other' })).toBe(false);
  });

  it('unsubscribe token redemption silences the template across all functions', async () => {
    const userId = await makeUser();

    const token = await createActionToken(pool, {
      userId,
      action: 'unsubscribe_template',
      payload: { template: 'function_failed' },
    });
    const consumed = await consumeActionToken(pool, token);
    await unsubscribeFromTemplate(pool, consumed!.userId, String(consumed!.payload.template));

    expect(await isSilenced(pool, userId, 'function_failed', { functionId: 'any_fn' })).toBe(true);
    expect(await isSilenced(pool, userId, 'function_failed', {})).toBe(true);
  });
});
