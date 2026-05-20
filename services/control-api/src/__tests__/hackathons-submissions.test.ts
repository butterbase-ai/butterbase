import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from './test-helpers/build-app.js';
import { setupTestDb, controlDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';
import { hashCode } from '../services/hackathons/codes.js';

const SCHEMA = { fields: [
  { key: 'project_name', type: 'text', required: true,  display: 'primary', label: 'Project' },
  { key: 'demo_url',     type: 'url',  required: true,  display: 'primary', label: 'Demo' },
  { key: 'team',         type: 'text[]', required: false, display: 'detail', label: 'Team' },
]};

describe('hackathons-mcp routes', () => {
  beforeEach(setupTestDb);

  it('POST /hackathons/submissions upserts and bumps version', async () => {
    const app = await buildApp();
    const u = await seedUser('a@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    const first = await app.inject({
      method: 'POST',
      url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().submission.version).toBe(1);

    const second = await app.inject({
      method: 'POST',
      url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X v2', demo_url: 'https://x2.dev' } },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().submission.version).toBe(2);
  });

  it('rejects after submission_deadline', async () => {
    const app = await buildApp();
    const u = await seedUser('a@x.com');
    const h = await seedHackathon({
      slug: 'h1',
      is_active: true,
      field_schema: SCHEMA,
      starts_at: new Date(Date.now() - 7200_000),
      ends_at: new Date(Date.now() + 7200_000),
      submission_deadline: new Date(Date.now() - 60_000),
    });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    // Pass hackathon_slug explicitly so the route looks up by slug (no SQL time filter)
    // and we exercise the in-route time-window check that returns 403 outside_submission_window.
    const res = await app.inject({
      method: 'POST',
      url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { hackathon_slug: 'h1', data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('outside_submission_window');
  });

  it('rejects validation failure with the schema in the error body', async () => {
    const app = await buildApp();
    const u = await seedUser('a@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    const res = await app.inject({
      method: 'POST',
      url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('validation_failed');
    expect(res.json().field_schema).toBeDefined();
  });

  it('GET /hackathons/active/my-status returns hackathon + eligible + no submission', async () => {
    const app = await buildApp();
    const u = await seedUser('mystatus@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-status',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ eligible: true, reason: null, submission: null });
    expect(body.hackathon).toMatchObject({ slug: 'h1', name: expect.any(String) });
  });

  it('GET /hackathons/active/my-status includes submission when one exists', async () => {
    const app = await buildApp();
    const u = await seedUser('mystatus2@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    await app.inject({
      method: 'POST',
      url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'MyProject', demo_url: 'https://demo.dev' } },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-status',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eligible).toBe(true);
    expect(body.submission).toMatchObject({ data: { project_name: 'MyProject' }, version: 1 });
  });

  it('GET /hackathons/active/my-status returns not_participant for unregistered user', async () => {
    const app = await buildApp();
    const u = await seedUser('nobody@x.com');
    await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-status',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ eligible: false, reason: 'not_participant', submission: null });
  });
});

describe('submit_hackathon_entry — code-based self-register', () => {
  beforeEach(setupTestDb);

  it('first submission with valid code creates participant + submission', async () => {
    const app = await buildApp();
    const u = await seedUser('a@x.com');
    const codeHash = await hashCode('VALID-CODE-1');
    const h = await seedHackathon({
      slug: 'h1', is_active: true, field_schema: SCHEMA,
      submission_code_hash: codeHash,
    });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { submission_code: 'VALID-CODE-1', data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().participant_created).toBe(true);
    const { rows } = await controlDb.query(
      `SELECT source, status FROM hackathon_participants WHERE hackathon_id = $1 AND user_id = $2`,
      [h.id, u.id]
    );
    expect(rows[0]).toEqual({ source: 'mcp_self_register', status: 'active' });
  });

  it('first submission with wrong code returns 401, no rows written', async () => {
    const app = await buildApp();
    const u = await seedUser('b@x.com');
    const codeHash = await hashCode('VALID-CODE-2');
    const h = await seedHackathon({
      slug: 'h1', is_active: true, field_schema: SCHEMA,
      submission_code_hash: codeHash,
    });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { submission_code: 'WRONG', data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_submission_code');
    const { rows: pRows } = await controlDb.query(`SELECT 1 FROM hackathon_participants WHERE hackathon_id = $1`, [h.id]);
    const { rows: sRows } = await controlDb.query(`SELECT 1 FROM hackathon_submissions WHERE hackathon_id = $1`, [h.id]);
    expect(pRows).toHaveLength(0);
    expect(sRows).toHaveLength(0);
  });

  it('second submission by same user does not require code (version bumps)', async () => {
    const app = await buildApp();
    const u = await seedUser('c@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    const first = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X v2', demo_url: 'https://x2.dev' } },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().submission.version).toBe(2);
  });

  it('second submission ignores stale code arg', async () => {
    const app = await buildApp();
    const u = await seedUser('d@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { submission_code: 'WRONG', data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(res.statusCode).toBe(201);
  });

  it('submission while revoked returns 403', async () => {
    const app = await buildApp();
    const u = await seedUser('e@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'revoked' });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('revoked');
  });

  it('first submission with no code arg returns 400 submission_code_required', async () => {
    const app = await buildApp();
    const u = await seedUser('f@x.com');
    await seedHackathon({ slug: 'h1', is_active: true, field_schema: SCHEMA });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/submissions',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { data: { project_name: 'X', demo_url: 'https://x.dev' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('submission_code_required');
  });
});
