import type pg from 'pg';

const SUFFIX = '-staging';
const MAX_LABEL = 63; // DNS label limit; apps.subdomain becomes <label>.butterbase.dev
const MAX_ATTEMPTS = 10;
const RANDOM_ATTEMPTS = 6;

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

/**
 * The pools a subdomain allocation must consult. BOTH are required, and the
 * control-plane one is the load-bearing half.
 *
 * Subdomains are a GLOBAL namespace, and the index that actually enforces that
 * is `user_app_index_subdomain_uniq` on the control-plane `org_app_index`
 * (migration 080, "Subdomains are a global namespace"). `apps.subdomain` in a
 * runtime plane carries `idx_apps_subdomain`, but a runtime plane is REGIONAL:
 * a subdomain held by an app in another region is invisible to it. Checking
 * only `apps` — which this function used to do — therefore hands out a
 * subdomain that a different region already owns, and the collision surfaces
 * later, inside the clone worker, after provisioning has started.
 *
 * `org_app_index` is also the exact table the clone worker checks before it
 * inserts, so allocating against it is what makes the request-time answer and
 * the worker-time write agree by construction rather than by luck.
 *
 * The regional `apps` check is kept as well, not replaced: it is strictly
 * additional strictness, and it catches a row that exists in `apps` but whose
 * `org_app_index` entry is missing (the drift class `app-index-reaper.ts`
 * exists to repair).
 */
export interface SubdomainAllocationPools {
  /** Control plane — `org_app_index`, the globally unique subdomain namespace. */
  controlDb: pg.Pool;
  /** The production app's regional runtime plane — `apps.subdomain`. */
  runtimeDb: pg.Pool;
}

async function isTaken(pools: SubdomainAllocationPools, candidate: string): Promise<boolean> {
  const globalHit = await pools.controlDb.query(
    `SELECT app_id FROM org_app_index WHERE subdomain = $1 LIMIT 1`, [candidate],
  );
  if (globalHit.rows.length > 0) return true;

  const regionalHit = await pools.runtimeDb.query(
    `SELECT subdomain FROM apps WHERE subdomain = $1 LIMIT 1`, [candidate],
  );
  return regionalHit.rows.length > 0;
}

/**
 * THE ONE ALLOCATOR for a staging app's subdomain.
 *
 * It is called twice — once by `startStaging`, whose answer is what the
 * `POST /v1/apps/:id/staging` response promises the caller, and once (only on
 * collision) by the clone worker, which is what actually gets written. There
 * is deliberately no second, worker-local derivation: the worker used to
 * derive its own `<name>-<random digits>` slug from the destination NAME,
 * which meant the API's answer and the app's real subdomain were computed by
 * two different algorithms against two different tables and agreed only by
 * coincidence.
 *
 * Deterministic ladder first (`-staging`, `-staging-2`, ... `-staging-10`) so
 * the common case gives a subdomain a human would have chosen. Only once that
 * ladder is exhausted does it fall back to a random suffix, mirroring the
 * clone worker's own long-standing strategy for ordinary clones. That fallback
 * is why this function throwing — and `startStaging` turning the throw into a
 * `NO_SUBDOMAIN` 409 — is now a genuine exhaustion of the namespace rather
 * than an artefact of a short numbered ladder refusing a create the worker
 * would have completed fine.
 */
export async function allocateStagingSubdomain(
  pools: SubdomainAllocationPools, prodSubdomain: string,
): Promise<string> {
  const base = deriveStagingName(prodSubdomain);
  if (!(await isTaken(pools, base))) return base;

  for (let n = 2; n <= MAX_ATTEMPTS; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_LABEL - suffix.length)}${suffix}`;
    if (!(await isTaken(pools, candidate))) return candidate;
  }

  // Numbered ladder exhausted. Widen with a random suffix rather than refusing
  // — see the doc comment: the old behaviour 409'd here while the worker,
  // using its own random-suffix scheme, would have succeeded.
  for (let attempt = 0; attempt < RANDOM_ATTEMPTS; attempt++) {
    const span = attempt < 3 ? 9000 : 90_000_000;
    const floor = attempt < 3 ? 1000 : 10_000_000;
    const suffix = `-${Math.floor(Math.random() * span + floor)}`;
    const candidate = `${base.slice(0, MAX_LABEL - suffix.length)}${suffix}`;
    if (!(await isTaken(pools, candidate))) return candidate;
  }

  throw new Error(
    `No free subdomain for staging of "${prodSubdomain}" after `
      + `${MAX_ATTEMPTS + RANDOM_ATTEMPTS} attempts.`,
  );
}

/**
 * Worker-side half of the single-allocator contract.
 *
 * `startStaging` pinned a subdomain onto the job and told the caller about it.
 * By the time the clone worker provisions the app, minutes may have passed and
 * something else may have claimed that name. This resolves the pin:
 *
 *  - free (the overwhelmingly common case) → the pinned value, verbatim. The
 *    API's answer is what lands.
 *  - taken → re-allocate through `allocateStagingSubdomain`, the SAME
 *    allocator, seeded from the pinned value (`deriveStagingName` is
 *    idempotent, so seeding from `foo-staging` continues the ladder at
 *    `foo-staging-2` rather than producing `foo-staging-staging`). The caller
 *    is then told what actually happened via a job warning — the standing rule
 *    on this feature: do the conservative thing, then name it.
 *
 * What it deliberately does NOT do is derive a second subdomain by a second
 * algorithm from the destination NAME, which is what the worker used to do for
 * staging jobs and is why the two answers disagreed by construction.
 */
export async function resolvePinnedStagingSubdomain(
  pools: SubdomainAllocationPools, pinned: string,
): Promise<{ subdomain: string; reallocated: boolean }> {
  if (!(await isTaken(pools, pinned))) return { subdomain: pinned, reallocated: false };
  const subdomain = await allocateStagingSubdomain(pools, pinned);
  return { subdomain, reallocated: true };
}

/**
 * THE ONE PLACE the clone worker decides a destination app's subdomain.
 *
 * Both branches live here, side by side, precisely because the defect this
 * replaces was that they lived in two different files and nobody could see
 * them together:
 *
 *   - `staging_create` with a pinned `dest_subdomain` → the pinned value,
 *     which is the value `POST /v1/apps/:id/staging` already reported to the
 *     caller. `resolvePinnedStagingSubdomain` only re-allocates if it has been
 *     taken since, and says so via `reallocated` so the caller can put that in
 *     the job record rather than letting it happen silently.
 *   - everything else (an ordinary clone, a template update, or a legacy
 *     staging job created before migration 119) → the long-standing
 *     derive-from-name-then-random-suffix behaviour, byte-identical, checked
 *     against `org_app_index` exactly as before.
 *
 * Extracted from `neon-task-worker.ts` rather than left inline so the decision
 * is testable on its own: the original defect was invisible to every test
 * because reaching it required driving the whole clone pipeline.
 */
export async function allocateDestSubdomainForJob(args: {
  job: { mode: string; dest_subdomain: string | null };
  pools: SubdomainAllocationPools;
  /** DNS-safe slug derived from the destination app name — the non-staging base. */
  baseSlug: string;
  logger: { warn(obj: unknown, msg?: string): void };
}): Promise<{ subdomain: string; reallocatedFrom?: string }> {
  const { job, pools, baseSlug, logger } = args;

  if (job.mode === 'staging_create' && job.dest_subdomain) {
    const pinned = job.dest_subdomain;
    const resolved = await resolvePinnedStagingSubdomain(pools, pinned);
    return resolved.reallocated
      ? { subdomain: resolved.subdomain, reallocatedFrom: pinned }
      : { subdomain: resolved.subdomain };
  }

  let destSubdomain = baseSlug;
  for (let attempt = 0; attempt < 6; attempt++) {
    const taken = await pools.controlDb.query<{ app_id: string }>(
      `SELECT app_id FROM org_app_index WHERE subdomain = $1`,
      [destSubdomain],
    );
    if (taken.rows.length === 0) break;
    // 4 digits for the first few retries, 8 for the last ones.
    const span = attempt < 3 ? 9000 : 90_000_000;
    const floor = attempt < 3 ? 1000 : 10_000_000;
    destSubdomain = `${baseSlug}-${Math.floor(Math.random() * span + floor)}`;
    if (attempt === 5) {
      logger.warn(
        { baseSlug },
        '[clone] subdomain still colliding after 6 attempts; inserting anyway — the UNIQUE index is the backstop',
      );
    }
  }
  return { subdomain: destSubdomain };
}
