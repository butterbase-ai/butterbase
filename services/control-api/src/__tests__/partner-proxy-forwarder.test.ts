import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { config } from '../config.js';
import { encrypt } from '../services/crypto.js';
import { forwardRequest, type ForwardInput } from '../services/partner-proxy/forwarder.js';
import { loadPool } from '../services/partner-proxy/pool.js';

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
    [`fwd-test-${Date.now()}`, 'fwd-test']
  );
  hackathonId = h.rows[0].id;
  const p = await db.query(
    `INSERT INTO partner_pools (hackathon_id, slug, display_name, base_url, auth_template)
     VALUES ($1,'demo','Demo','https://demo.example.com',
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
  vi.restoreAllMocks();
});

function makeInput(): ForwardInput {
  return {
    method: 'POST',
    pathAndQuery: '/v1/echo?x=1',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer bb_sk_orig' },
    body: Buffer.from('{"hello":"world"}'),
  };
}

describe('forwardRequest', () => {
  it('forwards verbatim with injected auth header on first success', async () => {
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('partner-key-1', ENC_KEY)]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    );

    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const result = await forwardRequest(db, pool, makeInput());

    expect(result.kind).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://demo.example.com/v1/echo?x=1');
    expect((init as RequestInit).method).toBe('POST');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer partner-key-1');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('host')).toBeNull();
    expect((init as RequestInit).body).toEqual(Buffer.from('{"hello":"world"}'));
  });

  it('fails over on 401 and uses next key', async () => {
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, last_used_at) VALUES ($1,$2,now() - interval '1 hour')`,
      [poolId, encrypt('dead-key', ENC_KEY)]);
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key, last_used_at) VALUES ($1,$2,now())`,
      [poolId, encrypt('good-key', ENC_KEY)]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const result = await forwardRequest(db, pool, makeInput());

    expect(result.kind).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);

    const r = await db.query(`SELECT status, last_failure_status FROM partner_keys WHERE pool_id = $1 ORDER BY status`, [poolId]);
    expect(r.rows.map((x) => x.status).sort()).toEqual(['active', 'exhausted']);
    const dead = r.rows.find((x) => x.status === 'exhausted');
    expect(dead.last_failure_status).toBe(401);
  });

  it('fails over on 429 and 402/403 too', async () => {
    for (const status of [402, 403, 429]) {
      await db.query(`DELETE FROM partner_keys WHERE pool_id = $1`, [poolId]);
      await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
        [poolId, encrypt('a', ENC_KEY)]);
      await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
        [poolId, encrypt('b', ENC_KEY)]);

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('x', { status }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));

      const pool = (await loadPool(db, hackathonId, 'demo'))!;
      const result = await forwardRequest(db, pool, makeInput());
      expect(result.kind).toBe('ok');
      vi.restoreAllMocks();
    }
  });

  it('returns exhausted when all keys are dead', async () => {
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`, [poolId, encrypt('a', ENC_KEY)]);
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`, [poolId, encrypt('b', ENC_KEY)]);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('quota', { status: 429 }));

    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const result = await forwardRequest(db, pool, makeInput());
    expect(result.kind).toBe('exhausted');
    expect(result.attempts).toBe(2);

    const r = await db.query(`SELECT status FROM partner_keys WHERE pool_id = $1`, [poolId]);
    expect(r.rows.every((x) => x.status === 'exhausted')).toBe(true);
  });

  it('caps failover at 3 attempts', async () => {
    for (let i = 0; i < 5; i++) {
      await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
        [poolId, encrypt(`k${i}`, ENC_KEY)]);
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('q', { status: 429 }));
    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const result = await forwardRequest(db, pool, makeInput());
    expect(result.kind).toBe('exhausted');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.attempts).toBe(3);
  });

  it('does not fail over on 5xx — returns the response as-is', async () => {
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`, [poolId, encrypt('a', ENC_KEY)]);
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`, [poolId, encrypt('b', ENC_KEY)]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const result = await forwardRequest(db, pool, makeInput());
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok kind');
    expect(result.response.status).toBe(500);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns no_keys when pool is empty', async () => {
    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const result = await forwardRequest(db, pool, makeInput());
    expect(result.kind).toBe('exhausted');
    expect(result.attempts).toBe(0);
  });

  it('strips host, authorization, cookie inbound and adds query auth when configured', async () => {
    await db.query(`UPDATE partner_pools SET auth_template = $1 WHERE id = $2`,
      [JSON.stringify({ location: 'query', name: 'api_key', template: '{{key}}' }), poolId]);
    await db.query(`INSERT INTO partner_keys (pool_id, encrypted_key) VALUES ($1,$2)`,
      [poolId, encrypt('partner-q', ENC_KEY)]);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const pool = (await loadPool(db, hackathonId, 'demo'))!;
    const input: ForwardInput = {
      ...makeInput(),
      headers: { host: 'evil', cookie: 'sess=x', authorization: 'Bearer bb_sk_x', 'content-type': 'application/json' },
      pathAndQuery: '/v1/echo?x=1',
    };
    await forwardRequest(db, pool, input);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://demo.example.com/v1/echo?x=1&api_key=partner-q');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('host')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('content-type')).toBe('application/json');
  });
});
