import { describe, expect, it, beforeEach } from 'vitest';
import { resolveEligibility, resolveEligibilityForHackathon } from '../services/hackathons/eligibility.js';
import { setupTestDb, controlDb, seedUser, seedHackathon, seedParticipant } from './test-helpers/control-db.js';

describe('resolveEligibility (post-redesign)', () => {
  beforeEach(setupTestDb);

  it('returns no_active_hackathon when none active', async () => {
    const u = await seedUser('a@x.com');
    const r = await resolveEligibility(controlDb, u.id);
    expect(r).toMatchObject({ eligible: false, reason: 'no_active_hackathon' });
  });

  it('returns no_active_hackathon when no hackathon is inside the submission date window', async () => {
    const u = await seedUser('a@x.com');
    const past = new Date(Date.now() - 86400_000 * 2);
    const pastEnd = new Date(Date.now() - 86400_000);
    await seedHackathon({ slug: 'h1', is_active: true, starts_at: past, ends_at: pastEnd, submission_deadline: pastEnd });
    const r = await resolveEligibility(controlDb, u.id);
    expect(r).toMatchObject({ eligible: false, reason: 'no_active_hackathon' });
  });

  it('returns not_participant when no participant row exists', async () => {
    const u = await seedUser('a@x.com');
    await seedHackathon({ slug: 'h1', is_active: true });
    const r = await resolveEligibility(controlDb, u.id);
    expect(r).toMatchObject({ eligible: false, reason: 'not_participant' });
  });

  it('returns revoked when participant.status = revoked', async () => {
    const u = await seedUser('a@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true });
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'revoked' });
    const r = await resolveEligibility(controlDb, u.id);
    expect(r).toMatchObject({ eligible: false, reason: 'revoked' });
  });

  it('returns eligible with participant_id when active', async () => {
    const u = await seedUser('a@x.com');
    const h = await seedHackathon({ slug: 'h1', is_active: true });
    const p = await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'active' });
    const r = await resolveEligibility(controlDb, u.id);
    expect(r).toMatchObject({ eligible: true, hackathon: { slug: 'h1' }, participant_id: p.id });
  });
});

describe('resolveEligibilityForHackathon', () => {
  beforeEach(setupTestDb);

  it('returns not_found for an unknown slug', async () => {
    const u = await seedUser('a@x.com');
    const r = await resolveEligibilityForHackathon(controlDb, u.id, 'no-such-thing');
    expect(r).toEqual({ eligible: false, reason: 'not_found' });
  });

  it('returns not_in_window for a past hackathon (even if user is a participant)', async () => {
    const past = new Date(Date.now() - 14 * 86_400_000);
    const pastEnd = new Date(Date.now() - 7 * 86_400_000);
    const h = await seedHackathon({
      slug: 'past-h', is_active: true,
      starts_at: past, ends_at: pastEnd, submission_deadline: pastEnd,
    });
    const u = await seedUser('a@x.com');
    await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const r = await resolveEligibilityForHackathon(controlDb, u.id, 'past-h');
    expect(r).toEqual({ eligible: false, reason: 'not_in_window' });
  });

  it('returns not_participant when user is not registered for the named hackathon', async () => {
    await seedHackathon({ slug: 'h-open', is_active: false });
    const u = await seedUser('a@x.com');
    const r = await resolveEligibilityForHackathon(controlDb, u.id, 'h-open');
    expect(r).toEqual({ eligible: false, reason: 'not_participant' });
  });

  it('returns eligible when user participates in the named in-window hackathon', async () => {
    const h = await seedHackathon({ slug: 'h-open', is_active: false });
    const u = await seedUser('a@x.com');
    await seedParticipant({ hackathon_id: h.id, user_id: u.id });
    const r = await resolveEligibilityForHackathon(controlDb, u.id, 'h-open');
    expect(r.eligible).toBe(true);
    if (r.eligible) {
      expect(r.hackathon.id).toBe(h.id);
      expect(r.hackathon.slug).toBe('h-open');
    }
  });

  it('returns revoked status correctly', async () => {
    const h = await seedHackathon({ slug: 'h-open', is_active: false });
    const u = await seedUser('a@x.com');
    await seedParticipant({ hackathon_id: h.id, user_id: u.id, status: 'revoked' });
    const r = await resolveEligibilityForHackathon(controlDb, u.id, 'h-open');
    expect(r).toEqual({ eligible: false, reason: 'revoked' });
  });

  it('selects the named hackathon even when another in-window one exists', async () => {
    await seedHackathon({ slug: 'h-A', is_active: true });
    const h2 = await seedHackathon({ slug: 'h-B', is_active: false });
    const u = await seedUser('a@x.com');
    await seedParticipant({ hackathon_id: h2.id, user_id: u.id });
    const r = await resolveEligibilityForHackathon(controlDb, u.id, 'h-B');
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.hackathon.id).toBe(h2.id);
  });
});
