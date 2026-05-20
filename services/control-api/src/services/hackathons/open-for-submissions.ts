/**
 * Selects a single in-window hackathon when no slug is supplied.
 *
 * Rule: most-recently-started hackathon whose submission window includes
 * server `now()`. The legacy `is_active` flag is intentionally NOT used —
 * multiple hackathons can be open simultaneously, and runtime behavior must
 * not depend on a flag that admins forget to flip.
 *
 * Callers that need to address a specific hackathon when several overlap
 * MUST pass an explicit slug (see resolveEligibilityForHackathon and the
 * /v1/:appId/partners/:hackathonSlug/* proxy routes).
 */
export const HACKATHON_OPEN_FOR_SUBMISSIONS_SQL_SUFFIX = `
  WHERE starts_at <= now()
    AND now() <= submission_deadline
  ORDER BY starts_at DESC
  LIMIT 1
`;
