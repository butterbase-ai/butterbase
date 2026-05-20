import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { config } from '../config.js';
import { encrypt } from '../services/crypto.js';
import {
  loadPool,
  pickNextKey,
  markKeyUsed,
  markKeyExhausted,
  countActiveKeys,
} from '../services/partner-proxy/pool.js';

if (!process.env.AUTH_ENCRYPTION_KEY) {
  process.env.AUTH_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
}
const db = new Pool({ connectionString: config.controlDb.url });
const ENC_KEY = process.env.AUTH_ENCRYPTION_KEY;
let hackathonId: string;
let poolId: string;

beforeAll(async () => {
  const h = await db.query(
    `INSERT INTO hackathons (slug, name, starts_at, ends_at, submission_deadline,
                             field_schema, is_active, submission_code_hash, judge_code_hash)
     VALUES ($1,$2, now() - interval '1 hour', now() + interval '1 day', now() + interval '1 day',
             '{"version":1,"fields":[]}'::jsonb, false, 'x', 'y') RETURNING id`,
    [`pool-test-${Date.now()}`, 'pool-test']
  );
  hackathonId = h.rows[0].id;
  const p = await db.query(
    `INSERT INTO partner_pools (hackathon_id, slug, display_name, base_url, auth_template)
     VALUES ($1,'seedance','Seedance','https://api.seedance.ai',
             '{"location":"header","name":"Authorization","template":"Bearer {{key}}"}'::jsonb)
     RETURNING id`,
    [hackathonId]
  );
  poolId = p.rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM hackathons WHERE id = $1', [hackathonId]);
  await db.end();
});

beforeEach(async () => {
  await db.query('DELETE FROM partner_keys WHERE pool_id = $1', [poolId]);
});

describe('loadPool', () => {
  it('returns the pool config by hackathon + slug', async () => {
    const result = await loadPool(db, hackathonId, 'seedance');
    expect(result).not.toBeNull();
    expect(result!.id).toBe(poolId);
    expect(result!.base_url).toBe('https://api.seedance.ai');
    expect(result!.auth_template.location).toBe('header');
  });

  it('returns null on unknown slug', async () => {
    const result = await loadPool(db, hackathonId, 'unknown');
    expect(result).toBeNull();
  });
});

describe('pickNextKey', () => {
  it('returns null when pool is empty', async () => {
    const k = await pickNextKey(db, poolId, []);
    expect(k).toBeNull();
  });

  it('picks the only active key', async () => {
    const ins = await db.query(
      `INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1, $2) RETURNING id`,
      [poolId, encrypt('key-a', ENC_KEY)]
    );
    const k = await pickNextKey(db, poolId, []);
    expect(k!.id).toBe(ins.rows[0].id);
    expect(k!.plaintext).toBe('key-a');
  });

  it('skips ids in the exclude list', async () => {
    const a = await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2) RETURNING id`,
      [poolId, encrypt('key-a', ENC_KEY)]);
    const b = await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2) RETURNING id`,
      [poolId, encrypt('key-b', ENC_KEY)]);
    const k = await pickNextKey(db, poolId, [a.rows[0].id]);
    expect(k!.id).toBe(b.rows[0].id);
  });

  it('skips exhausted and revoked keys', async () => {
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, status) VALUES ($1,$2,'exhausted')`,
      [poolId, encrypt('key-dead', ENC_KEY)]);
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, status) VALUES ($1,$2,'revoked')`,
      [poolId, encrypt('key-revoked', ENC_KEY)]);
    const live = await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2) RETURNING id`,
      [poolId, encrypt('key-live', ENC_KEY)]);
    const k = await pickNextKey(db, poolId, []);
    expect(k!.id).toBe(live.rows[0].id);
  });

  it('revokes corrupt key and returns next valid key', async () => {
    // Take a real ciphertext but flip its auth tag — guarantees decrypt() throws.
    const valid = encrypt('original', ENC_KEY);
    const parts = valid.split(':');
    parts[2] = Buffer.from('a'.repeat(16)).toString('base64'); // bogus auth tag
    const tampered = parts.join(':');
    // Make sure the corrupt row sorts first by inserting it with NULL last_used_at
    // ahead of the good one (they tie on last_used_at, so id-order resolves it —
    // we just need both inserted and verify pickNextKey skips the corrupt one).
    const corrupt = await db.query(
      `INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1, $2) RETURNING id`,
      [poolId, tampered]
    );
    // Force the good key to sort AFTER corrupt by giving it a non-null last_used_at
    // (NULLS FIRST puts the corrupt row at the head of the queue deterministically).
    const good = await db.query(
      `INSERT INTO partner_keys (pool_id, encrypted_key, last_used_at)
       VALUES ($1, $2, now()) RETURNING id`,
      [poolId, encrypt('good-key', ENC_KEY)]
    );

    const k = await pickNextKey(db, poolId, []);
    expect(k).not.toBeNull();
    expect(k!.id).toBe(good.rows[0].id);
    expect(k!.plaintext).toBe('good-key');

    const r = await db.query(`SELECT status FROM partner_keys WHERE id = $1`, [corrupt.rows[0].id]);
    expect(r.rows[0].status).toBe('revoked');
  });

  it('bails after 10 corrupt keys and returns null', async () => {
    // Build 12 ciphertexts with bogus auth tags so they all fail to decrypt.
    for (let i = 0; i < 12; i++) {
      const valid = encrypt(`k${i}`, ENC_KEY);
      const parts = valid.split(':');
      parts[2] = Buffer.from('z'.repeat(16)).toString('base64');
      await db.query(
        `INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1, $2)`,
        [poolId, parts.join(':')]
      );
    }
    const k = await pickNextKey(db, poolId, []);
    expect(k).toBeNull();
    // Exactly 10 should have been revoked; the rest stay 'active'.
    const r = await db.query(
      `SELECT status, count(*)::int n FROM partner_keys WHERE pool_id = $1 GROUP BY status`,
      [poolId]
    );
    const byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    expect(byStatus.revoked).toBe(10);
    expect(byStatus.active).toBe(2);
  });

  it('prefers least-recently-used active key', async () => {
    const a = await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, last_used_at) VALUES ($1,$2,now()) RETURNING id`,
      [poolId, encrypt('key-recent', ENC_KEY)]);
    const b = await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, last_used_at) VALUES ($1,$2,now() - interval '1 hour') RETURNING id`,
      [poolId, encrypt('key-old', ENC_KEY)]);
    void a;
    const k = await pickNextKey(db, poolId, []);
    expect(k!.id).toBe(b.rows[0].id);
  });
});

describe('markKeyUsed', () => {
  it('sets last_used_at and bumps use_count', async () => {
    const ins = await db.query(
      `INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2) RETURNING id`,
      [poolId, encrypt('k', ENC_KEY)]
    );
    await markKeyUsed(db, ins.rows[0].id);
    const r = await db.query(`SELECT last_used_at, use_count FROM partner_keys WHERE id = $1`, [ins.rows[0].id]);
    expect(r.rows[0].last_used_at).not.toBeNull();
    expect(Number(r.rows[0].use_count)).toBe(1);
  });
});

describe('markKeyExhausted', () => {
  it('sets status=exhausted with failure metadata', async () => {
    const ins = await db.query(
      `INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2) RETURNING id`,
      [poolId, encrypt('k', ENC_KEY)]
    );
    await markKeyExhausted(db, ins.rows[0].id, 429, '{"error":"quota"}');
    const r = await db.query(`SELECT status, last_failure_status, last_failure_body, failure_count FROM partner_keys WHERE id = $1`, [ins.rows[0].id]);
    expect(r.rows[0].status).toBe('exhausted');
    expect(r.rows[0].last_failure_status).toBe(429);
    expect(r.rows[0].last_failure_body).toBe('{"error":"quota"}');
    expect(r.rows[0].failure_count).toBe(1);
  });

  it('truncates large failure bodies to 1KB', async () => {
    const ins = await db.query(
      `INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2) RETURNING id`,
      [poolId, encrypt('k', ENC_KEY)]
    );
    const huge = 'x'.repeat(5000);
    await markKeyExhausted(db, ins.rows[0].id, 401, huge);
    const r = await db.query(`SELECT last_failure_body FROM partner_keys WHERE id = $1`, [ins.rows[0].id]);
    expect(r.rows[0].last_failure_body.length).toBe(1024);
  });
});

describe('countActiveKeys', () => {
  it('returns 0 when no active keys', async () => {
    expect(await countActiveKeys(db, poolId)).toBe(0);
  });

  it('counts only active keys', async () => {
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`, [poolId, encrypt('a', ENC_KEY)]);
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, status) VALUES ($1,$2,'exhausted')`, [poolId, encrypt('b', ENC_KEY)]);
    expect(await countActiveKeys(db, poolId)).toBe(1);
  });
});
