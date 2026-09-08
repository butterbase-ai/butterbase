import type pg from 'pg';

const SUFFIX = '-staging';
const MAX_LABEL = 63; // DNS label limit; apps.subdomain becomes <label>.butterbase.dev
const MAX_ATTEMPTS = 10;

/**
 * Idempotent: deriving from an already-staging name returns it unchanged, so a
 * double-create cannot produce `foo-staging-staging`.
 */
export function deriveStagingName(prodName: string): string {
  const base = prodName.replace(/_/g, '-').toLowerCase();
  // Strip an existing suffix first so the function is idempotent, then re-apply
  // it with room reserved — truncating the combined string instead would cut the
  // suffix off an already-long "-staging" name and can leave a trailing hyphen,
  // which is not a legal DNS label.
  const stem = base.endsWith(SUFFIX) ? base.slice(0, -SUFFIX.length) : base;
  const room = MAX_LABEL - SUFFIX.length;
  return `${stem.slice(0, room)}${SUFFIX}`;
}

async function isTaken(runtimeDb: pg.Pool, candidate: string): Promise<boolean> {
  const res = await runtimeDb.query(
    `SELECT subdomain FROM apps WHERE subdomain = $1 LIMIT 1`, [candidate],
  );
  return res.rows.length > 0;
}

export async function allocateStagingSubdomain(
  runtimeDb: pg.Pool, prodSubdomain: string,
): Promise<string> {
  const base = deriveStagingName(prodSubdomain);
  if (!(await isTaken(runtimeDb, base))) return base;

  for (let n = 2; n <= MAX_ATTEMPTS; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_LABEL - suffix.length)}${suffix}`;
    if (!(await isTaken(runtimeDb, candidate))) return candidate;
  }
  throw new Error(
    `No free subdomain for staging of "${prodSubdomain}" after ${MAX_ATTEMPTS} attempts.`,
  );
}
