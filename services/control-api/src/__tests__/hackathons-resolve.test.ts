import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from './test-helpers/build-app.js';
import { setupTestDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';
import { hashCode } from '../services/hackathons/codes.js';

const SCHEMA = { fields: [
  { key: 'project_name', type: 'text', required: true, display: 'primary', label: 'Project' },
]};

describe('POST /hackathons/resolve', () => {
  beforeEach(setupTestDb);

  it('resolves by submission_code among multiple open hackathons', async () => {
    const app = await buildApp();
    const u = await seedUser('a@x.com');
    const hashA = await hashCode('CODE-AAAA');
    const hashB = await hashCode('CODE-BBBB');
    await seedHackathon({ slug: 'h-a', is_active: true, field_schema: SCHEMA, submission_code_hash: hashA });
    await seedHackathon({ slug: 'h-b', is_active: false, field_schema: SCHEMA, submission_code_hash: hashB });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { submission_code: 'CODE-BBBB' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match_reason).toBe('submission_code');
    expect(body.matched.slug).toBe('h-b');
    expect(body.open_hackathons).toHaveLength(2);
  });

  it('returns 401 invalid_submission_code with open_hackathons when code matches none', async () => {
    const app = await buildApp();
    const u = await seedUser('b@x.com');
    const hashA = await hashCode('CODE-AAAA');
    await seedHackathon({ slug: 'h-a', is_active: true, field_schema: SCHEMA, submission_code_hash: hashA });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: { submission_code: 'NOPE-NOPE' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_submission_code');
    expect(res.json().open_hackathons).toHaveLength(1);
  });

  it('falls back to user binding when no code is given and user is bound to one open hackathon', async () => {
    const app = await buildApp();
    const u = await seedUser('c@x.com');
    const ha = await seedHackathon({ slug: 'h-a', is_active: true, field_schema: SCHEMA });
    await seedHackathon({ slug: 'h-b', is_active: false, field_schema: SCHEMA });
    await seedParticipant({ hackathon_id: ha.id, user_id: u.id, status: 'active' });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match_reason).toBe('already_bound');
    expect(body.matched.slug).toBe('h-a');
  });

  it('matches the only open hackathon when no code and no binding', async () => {
    const app = await buildApp();
    const u = await seedUser('d@x.com');
    await seedHackathon({ slug: 'only', is_active: true, field_schema: SCHEMA });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match_reason).toBe('single_open');
    expect(body.matched.slug).toBe('only');
  });

  it('returns matched=null with the list when ambiguous (multiple open, no code, no binding)', async () => {
    const app = await buildApp();
    const u = await seedUser('e@x.com');
    await seedHackathon({ slug: 'h-a', is_active: true, field_schema: SCHEMA });
    await seedHackathon({ slug: 'h-b', is_active: false, field_schema: SCHEMA });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matched).toBeNull();
    expect(body.match_reason).toBeNull();
    expect(body.open_hackathons).toHaveLength(2);
  });

  it('excludes hackathons outside their submission window', async () => {
    const app = await buildApp();
    const u = await seedUser('f@x.com');
    await seedHackathon({
      slug: 'expired', is_active: true, field_schema: SCHEMA,
      starts_at: new Date(Date.now() - 7200_000),
      ends_at: new Date(Date.now() - 60_000),
      submission_deadline: new Date(Date.now() - 60_000),
    });

    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'x-test-user-id': u.id, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matched).toBeNull();
    expect(body.open_hackathons).toHaveLength(0);
  });

  it('requires auth', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/hackathons/resolve',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
