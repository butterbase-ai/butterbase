import type { Pool } from 'pg';

import { HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX } from './open-for-submissions.js';

export type EligibilityResult =
  | { eligible: true; hackathon: { id: string; slug: string; submission_deadline: string }; participant_id: string }
  | { eligible: false; reason: 'no_active_hackathon' | 'not_in_window' | 'not_participant' | 'revoked' };

export async function resolveEligibility(db: Pool, userId: string): Promise<EligibilityResult> {
  const { rows: hRows } = await db.query<{
    id: string; slug: string; submission_deadline: string;
  }>(
    `SELECT id, slug, submission_deadline
     FROM hackathons
     ${HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX}`
  );
  if (hRows.length === 0) return { eligible: false, reason: 'no_active_hackathon' };
  const h = hRows[0];

  const { rows: pRows } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM hackathon_participants
     WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1`,
    [h.id, userId]
  );

  if (pRows.length === 0) return { eligible: false, reason: 'not_participant' };
  if (pRows[0].status === 'revoked') return { eligible: false, reason: 'revoked' };

  return {
    eligible: true,
    hackathon: { id: h.id, slug: h.slug, submission_deadline: h.submission_deadline },
    participant_id: pRows[0].id,
  };
}

export type EligibilityForHackathonResult =
  | { eligible: true; hackathon: { id: string; slug: string; submission_deadline: string }; participant_id: string }
  | { eligible: false; reason: 'not_found' | 'not_in_window' | 'not_participant' | 'revoked' };

export async function resolveEligibilityForHackathon(
  db: Pool,
  userId: string,
  hackathonSlug: string,
): Promise<EligibilityForHackathonResult> {
  const { rows: hRows } = await db.query<{
    id: string; slug: string; submission_deadline: string; in_window: boolean;
  }>(
    `SELECT id, slug, submission_deadline,
            (now() BETWEEN starts_at AND submission_deadline) AS in_window
       FROM hackathons WHERE slug = $1`,
    [hackathonSlug],
  );
  if (hRows.length === 0) return { eligible: false, reason: 'not_found' };
  const h = hRows[0];
  if (!h.in_window) return { eligible: false, reason: 'not_in_window' };

  const { rows: pRows } = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM hackathon_participants
       WHERE hackathon_id = $1 AND user_id = $2 LIMIT 1`,
    [h.id, userId],
  );
  if (pRows.length === 0) return { eligible: false, reason: 'not_participant' };
  if (pRows[0].status === 'revoked') return { eligible: false, reason: 'revoked' };

  return {
    eligible: true,
    hackathon: { id: h.id, slug: h.slug, submission_deadline: h.submission_deadline },
    participant_id: pRows[0].id,
  };
}
