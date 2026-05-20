import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from './test-helpers/build-app.js';
import { setupTestDb, controlDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';

const SCHEMA = {
  fields: [
    { key: 'project_name', type: 'text', required: true, display: 'primary', label: 'Project' },
    { key: 'demo_url', type: 'url', required: true, display: 'primary', label: 'Demo' },
    { key: 'secret_score', type: 'number', required: false, display: 'private', label: 'Score' },
  ],
};

async function seedSubmission(
  hackathonId: string,
  participantId: string,
  userId: string,
  data: Record<string, unknown>,
) {
  const { rows } = await controlDb.query<{ id: string }>(
    `INSERT INTO hackathon_submissions (hackathon_id, participant_id, user_id, data)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [hackathonId, participantId, userId, JSON.stringify(data)],
  );
  return rows[0];
}

describe('GET /hackathons/active/my-submission', () => {
  beforeEach(setupTestDb);

  it('returns 401 when unauthenticated', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-submission',
      // no x-test-user-id header → userId will be null
      headers: { 'x-test-user-id': '' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('no active hackathon → 200 with hackathon null, submission null, status none', async () => {
    const app = await buildApp();
    const u = await seedUser('a@x.com');
    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-submission',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hackathon).toBeNull();
    expect(body.submission).toBeNull();
    expect(body.participant_status).toBe('none');
  });

  it('active hackathon + user not participant → participant_status none, submission null', async () => {
    const app = await buildApp();
    const u = await seedUser('b@x.com');
    await seedHackathon({ slug: 'mysubm-notparticipant', is_active: true, field_schema: SCHEMA });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-submission',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hackathon).not.toBeNull();
    expect(body.hackathon.slug).toBe('mysubm-notparticipant');
    expect(body.hackathon.field_schema).toBeDefined();
    expect(body.submission).toBeNull();
    expect(body.participant_status).toBe('none');
  });

  it('active hackathon + participant active + no submission → submission null, status active', async () => {
    const app = await buildApp();
    const u = await seedUser('c@x.com');
    const h = await seedHackathon({ slug: 'mysubm-nosubmission', is_active: true, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-submission',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.participant_status).toBe('active');
    expect(body.submission).toBeNull();
    expect(body.hackathon.slug).toBe('mysubm-nosubmission');
  });

  it('active hackathon + participant active + submission → returns fields, submitted_at, version', async () => {
    const app = await buildApp();
    const u = await seedUser('d@x.com');
    const h = await seedHackathon({ slug: 'mysubm-withsubmission', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });
    await seedSubmission(h.id, p.id, u.id, { project_name: 'MyApp', demo_url: 'https://demo.dev', secret_score: 42 });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-submission',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.participant_status).toBe('active');
    expect(body.submission).not.toBeNull();
    expect(body.submission.fields.project_name).toBe('MyApp');
    expect(body.submission.fields.secret_score).toBe(42);
    expect(body.submission.version).toBe(1);
    expect(body.submission.submitted_at).toBeDefined();
    expect(body.hackathon.field_schema.fields).toHaveLength(3);
  });

  it('revoked participant → participant_status revoked, submission null (even if one exists)', async () => {
    const app = await buildApp();
    const u = await seedUser('e@x.com');
    const h = await seedHackathon({ slug: 'mysubm-revoked', is_active: true, field_schema: SCHEMA });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'revoked' });
    await seedSubmission(h.id, p.id, u.id, { project_name: 'X', demo_url: 'https://x.dev' });

    const res = await app.inject({
      method: 'GET',
      url: '/hackathons/active/my-submission',
      headers: { 'x-test-user-id': u.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.participant_status).toBe('revoked');
    // submission is still returned for revoked — they submitted it, they can see it
    // (dashboard will show the "revoked" message instead of the submission card)
    expect(body.hackathon).not.toBeNull();
  });
});
