/**
 * Real-DB coverage for staging-link-reconciler.ts.
 *
 * This sweeper MUTATES — it writes `app_environments` rows — so a mock-only,
 * string-matching test is not sufficient: a fully mocked DB can never contain a
 * production app for the identification to wrongly match, so it cannot catch a
 * regression in the predicates themselves (a widened join, an `OR` where an
 * `AND` belongs, a dropped guard). This follows the pattern established by
 * staging-reaper-integration.test.ts — real fixtures against the real control
 * and runtime planes, cleaned up in afterAll.
 *
 * THE FIXTURES ARE BUILT SO THAT SCOPING, NOT A DATE FILTER, IS WHAT PROTECTS
 * PRODUCTION. Exactly as in staging-reaper-integration.test.ts, every
 * production anchor here is deliberately OLD — its clone job completed far
 * outside the grace window — so the grace filter admits it as a candidate on
 * its own. The ONLY thing keeping a production app from being written as
 * somebody's `staging_app_id` is that candidates are drawn from
 * `template_clone_jobs.dest_app_id` where `mode = 'staging_create'`, and a
 * production app never appears there. If that scoping were widened, these
 * tests go red; if it were only a date filter doing the work by accident, the
 * aged fixtures would already have exposed it.
 *
 * Run with:
 *   npx vitest run services/control-api/src/services/staging-link-reconciler-integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { reconcileStagingLinks } from './staging-link-reconciler.js';

const CONTROL_URL =
  process.env.NEON_PLATFORM_PRIMARY_URL ??
  process.env.CONTROL_DB_URL ??
  'postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control';
const RUNTIME_URL =
  process.env.NEON_RUNTIME_PROJECT_ID_US_EAST_1 ??
  'postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us';

let controlDb: pg.Pool;
let runtimeDb: pg.Pool;

const USER = '00000000-0000-0000-0000-0000000000f1';
const REGION = 'us-east-1';

// One prod/staging pair per scenario, so a wrong predicate in one scenario
// cannot be masked by a correct one in another.
const PROD_ORPHAN = 'app_test_slr_prod_orphan';
const STAGING_ORPHAN = 'app_test_slr_staging_orphan';
const PROD_UNLINKED = 'app_test_slr_prod_unlinked';
const STAGING_UNLINKED = 'app_test_slr_staging_unlinked';
const PROD_YOUNG = 'app_test_slr_prod_young';
const STAGING_YOUNG = 'app_test_slr_staging_young';
const PROD_INFLIGHT = 'app_test_slr_prod_inflight';
const STAGING_INFLIGHT = 'app_test_slr_staging_inflight';
const PROD_NOTREADY = 'app_test_slr_prod_notready';
const STAGING_NOTREADY = 'app_test_slr_staging_notready';
const PROD_LINEAGE = 'app_test_slr_prod_lineage';
const STAGING_LINEAGE = 'app_test_slr_staging_lineage';
const PROD_AMBIG = 'app_test_slr_prod_ambig';
const STAGING_AMBIG_A = 'app_test_slr_staging_ambig_a';
const STAGING_AMBIG_B = 'app_test_slr_staging_ambig_b';
const PROD_LINKED = 'app_test_slr_prod_linked';
const STAGING_LINKED = 'app_test_slr_staging_linked';
// An ordinary app with no staging_create job anywhere near it.
const ORDINARY = 'app_test_slr_ordinary';

const ALL_APP_IDS = [
  PROD_ORPHAN, STAGING_ORPHAN,
  PROD_UNLINKED, STAGING_UNLINKED,
  PROD_YOUNG, STAGING_YOUNG,
  PROD_INFLIGHT, STAGING_INFLIGHT,
  PROD_NOTREADY, STAGING_NOTREADY,
  PROD_LINEAGE, STAGING_LINEAGE,
  PROD_AMBIG, STAGING_AMBIG_A, STAGING_AMBIG_B,
  PROD_LINKED, STAGING_LINKED,
  ORDINARY,
];

const JOB_PREFIX = 'cj_test_slr_';
const DAY = 24 * 60 * 60 * 1000;
const OLD = () => new Date(Date.now() - 10 * DAY);
const RECENT = () => new Date(Date.now() - 60 * 60 * 1000); // 1h, inside a 24h grace

const logger = { info: () => {}, warn: () => {}, error: () => {} };

async function insertApp(
  id: string,
  opts: { status?: string; lineage?: string | null } = {},
) {
  await runtimeDb.query(
    `INSERT INTO apps (id, name, owner_id, db_name, region, provisioning_status, template_source_app_id)
     VALUES ($1, $1, $2, $1, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET provisioning_status = EXCLUDED.provisioning_status,
           template_source_app_id = EXCLUDED.template_source_app_id`,
    [id, USER, REGION, opts.status ?? 'ready', opts.lineage ?? null],
  );
}

async function insertJob(args: {
  id: string;
  prodAppId: string;
  stagingAppId: string | null;
  mode?: string;
  status?: string;
  completedAt?: Date | null;
}) {
  await runtimeDb.query('SELECT 1'); // keep the pools symmetric in failure output
  await controlDb.query(
    `INSERT INTO template_clone_jobs
       (id, source_app_id, source_region, dest_region, requested_by_user_id,
        dest_app_id, mode, status, completed_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE
       SET dest_app_id = EXCLUDED.dest_app_id,
           mode = EXCLUDED.mode,
           status = EXCLUDED.status,
           completed_at = EXCLUDED.completed_at`,
    [
      args.id, args.prodAppId, REGION, USER, args.stagingAppId,
      args.mode ?? 'staging_create', args.status ?? 'completed',
      args.completedAt === undefined ? OLD() : args.completedAt,
    ],
  );
}

async function link(prodAppId: string, stagingAppId: string) {
  await runtimeDb.query(
    `INSERT INTO app_environments (prod_app_id, staging_app_id, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (prod_app_id) DO UPDATE SET staging_app_id = EXCLUDED.staging_app_id`,
    [prodAppId, stagingAppId, USER],
  );
}

async function linkedStagingFor(prodAppId: string): Promise<string | null> {
  const res = await runtimeDb.query<{ staging_app_id: string }>(
    `SELECT staging_app_id FROM app_environments WHERE prod_app_id = $1`, [prodAppId],
  );
  return res.rows[0]?.staging_app_id ?? null;
}

/** Every link row this test's apps participate in, in either column. */
async function allLinks(): Promise<Array<{ prod: string; staging: string }>> {
  const res = await runtimeDb.query<{ prod_app_id: string; staging_app_id: string }>(
    `SELECT prod_app_id, staging_app_id FROM app_environments
      WHERE prod_app_id = ANY($1) OR staging_app_id = ANY($1)`,
    [ALL_APP_IDS],
  );
  return res.rows.map((r) => ({ prod: r.prod_app_id, staging: r.staging_app_id }));
}

function run(overrides: Partial<Parameters<typeof reconcileStagingLinks>[2]> = {}) {
  return reconcileStagingLinks(controlDb, logger, {
    graceHours: 24,
    maxRelinksPerRun: 50,
    dryRun: false,
    runtimePoolForRegion: () => runtimeDb,
    ...overrides,
  });
}

async function cleanup() {
  await controlDb.query(`DELETE FROM template_clone_jobs WHERE id LIKE $1`, [`${JOB_PREFIX}%`]);
  await controlDb.query(`DELETE FROM audit_events WHERE app_id = ANY($1)`, [ALL_APP_IDS]);
  await runtimeDb.query(
    `DELETE FROM app_environments WHERE prod_app_id = ANY($1) OR staging_app_id = ANY($1)`,
    [ALL_APP_IDS],
  );
  await runtimeDb.query(`DELETE FROM apps WHERE id = ANY($1)`, [ALL_APP_IDS]);
}

beforeAll(async () => {
  controlDb = new pg.Pool({ connectionString: CONTROL_URL });
  runtimeDb = new pg.Pool({ connectionString: RUNTIME_URL });
});

afterAll(async () => {
  await cleanup();
  await controlDb.end();
  await runtimeDb.end();
});

beforeEach(async () => {
  await cleanup();

  // 1. The genuine orphan: provisioned, ready, lineage corroborated, no link.
  await insertApp(PROD_ORPHAN);
  await insertApp(STAGING_ORPHAN, { lineage: PROD_ORPHAN });
  await insertJob({ id: `${JOB_PREFIX}orphan`, prodAppId: PROD_ORPHAN, stagingAppId: STAGING_ORPHAN });

  // 2. Deliberately unlinked by the user via DELETE /v1/apps/:id/staging.
  await insertApp(PROD_UNLINKED);
  await insertApp(STAGING_UNLINKED, { lineage: PROD_UNLINKED });
  await insertJob({
    id: `${JOB_PREFIX}unlinked`, prodAppId: PROD_UNLINKED, stagingAppId: STAGING_UNLINKED,
  });
  await controlDb.query(
    `INSERT INTO audit_events (app_id, category, event_type, action, resource_type, resource_id,
                               actor_type, actor_id, event_data, success)
     VALUES ($1, 'admin', 'staging.unlink', 'delete', 'app', $2, 'platform_user', $3, '{}', true)`,
    [PROD_UNLINKED, STAGING_UNLINKED, USER],
  );

  // 3. Completed an hour ago — inside the grace window.
  await insertApp(PROD_YOUNG);
  await insertApp(STAGING_YOUNG, { lineage: PROD_YOUNG });
  await insertJob({
    id: `${JOB_PREFIX}young`, prodAppId: PROD_YOUNG, stagingAppId: STAGING_YOUNG,
    completedAt: RECENT(),
  });

  // 4. A second, non-terminal job still owns the pair.
  await insertApp(PROD_INFLIGHT);
  await insertApp(STAGING_INFLIGHT, { lineage: PROD_INFLIGHT });
  await insertJob({
    id: `${JOB_PREFIX}inflight`, prodAppId: PROD_INFLIGHT, stagingAppId: STAGING_INFLIGHT,
  });
  await insertJob({
    id: `${JOB_PREFIX}inflight2`, prodAppId: PROD_INFLIGHT, stagingAppId: STAGING_INFLIGHT,
    mode: 'staging_reset', status: 'copying_data', completedAt: null,
  });

  // 5. The destination never finished provisioning.
  await insertApp(PROD_NOTREADY);
  await insertApp(STAGING_NOTREADY, { status: 'provisioning', lineage: PROD_NOTREADY });
  await insertJob({
    id: `${JOB_PREFIX}notready`, prodAppId: PROD_NOTREADY, stagingAppId: STAGING_NOTREADY,
  });

  // 6. The two planes disagree about what this app is.
  await insertApp(PROD_LINEAGE);
  await insertApp(STAGING_LINEAGE, { lineage: ORDINARY });
  await insertJob({
    id: `${JOB_PREFIX}lineage`, prodAppId: PROD_LINEAGE, stagingAppId: STAGING_LINEAGE,
  });

  // 7. Two completed destinations for one production app — unresolvable.
  await insertApp(PROD_AMBIG);
  await insertApp(STAGING_AMBIG_A, { lineage: PROD_AMBIG });
  await insertApp(STAGING_AMBIG_B, { lineage: PROD_AMBIG });
  await insertJob({
    id: `${JOB_PREFIX}ambig_a`, prodAppId: PROD_AMBIG, stagingAppId: STAGING_AMBIG_A,
  });
  await insertJob({
    id: `${JOB_PREFIX}ambig_b`, prodAppId: PROD_AMBIG, stagingAppId: STAGING_AMBIG_B,
  });

  // 8. Already healthy.
  await insertApp(PROD_LINKED);
  await insertApp(STAGING_LINKED, { lineage: PROD_LINKED });
  await insertJob({
    id: `${JOB_PREFIX}linked`, prodAppId: PROD_LINKED, stagingAppId: STAGING_LINKED,
  });
  await link(PROD_LINKED, STAGING_LINKED);

  // 9. A completely ordinary app: no staging_create job names it in either
  //    column. It exists so a widened candidate query has something innocent
  //    to grab.
  await insertApp(ORDINARY);
});

describe('staging-link-reconciler — real-DB safety property', () => {
  it('relinks the genuine orphan', async () => {
    const report = await run();
    expect(report.relinked.map((c) => c.staging_app_id)).toContain(STAGING_ORPHAN);
    expect(await linkedStagingFor(PROD_ORPHAN)).toBe(STAGING_ORPHAN);
  });

  // THE SAFETY PROPERTY. Every production anchor here is old enough to clear
  // the grace window on its own, so only the scoping keeps it out.
  it('never writes a production app as anybody\'s staging_app_id', async () => {
    await run();
    const links = await allLinks();
    const productionAnchors = [
      PROD_ORPHAN, PROD_UNLINKED, PROD_YOUNG, PROD_INFLIGHT,
      PROD_NOTREADY, PROD_LINEAGE, PROD_AMBIG, PROD_LINKED, ORDINARY,
    ];
    for (const prod of productionAnchors) {
      expect(links.map((l) => l.staging)).not.toContain(prod);
    }
  });

  it('never touches an ordinary app that no staging_create job names', async () => {
    const report = await run();
    const named = [
      ...report.relinked, ...report.wouldRelink, ...report.flagged,
    ].flatMap((c) => [c.prod_app_id, c.staging_app_id]);
    expect(named).not.toContain(ORDINARY);
    const links = await allLinks();
    expect(links.flatMap((l) => [l.prod, l.staging])).not.toContain(ORDINARY);
  });

  // A production app that has HAD a staging environment requested of it is the
  // defining production trait. Promote that anchor into a candidate position
  // and the reconciler must refuse it rather than link it.
  it('refuses a candidate that is itself the source of a staging_create job', async () => {
    // PROD_ORPHAN is the source of ${JOB_PREFIX}orphan. Fabricate a job whose
    // DESTINATION is that same production app — the shape a corrupted or
    // hand-edited row would have — and confirm it is flagged, never written.
    await insertJob({
      id: `${JOB_PREFIX}poisoned`, prodAppId: ORDINARY, stagingAppId: PROD_ORPHAN,
    });
    const report = await run();
    const flaggedIds = report.flagged.map((c) => c.staging_app_id);
    expect(flaggedIds).toContain(PROD_ORPHAN);
    expect(await linkedStagingFor(ORDINARY)).toBeNull();
  });

  it('refuses to relink a staging app the user deliberately unlinked', async () => {
    const report = await run();
    expect(report.skippedDeliberateUnlink).toBeGreaterThanOrEqual(1);
    expect(report.relinked.map((c) => c.staging_app_id)).not.toContain(STAGING_UNLINKED);
    expect(await linkedStagingFor(PROD_UNLINKED)).toBeNull();
  });

  it('leaves a job inside the grace window alone (real date predicate)', async () => {
    const report = await run();
    expect(report.relinked.map((c) => c.staging_app_id)).not.toContain(STAGING_YOUNG);
    expect(await linkedStagingFor(PROD_YOUNG)).toBeNull();
  });

  it('does not race a worker that still owns either app', async () => {
    const report = await run();
    expect(report.skippedInflight).toBeGreaterThanOrEqual(1);
    expect(await linkedStagingFor(PROD_INFLIGHT)).toBeNull();
  });

  it('refuses a destination that never reached provisioning_status = ready', async () => {
    const report = await run();
    expect(report.relinked.map((c) => c.staging_app_id)).not.toContain(STAGING_NOTREADY);
    expect(await linkedStagingFor(PROD_NOTREADY)).toBeNull();
  });

  it('flags rather than links when the two planes disagree about lineage', async () => {
    const report = await run();
    expect(report.flagged.map((c) => c.staging_app_id)).toContain(STAGING_LINEAGE);
    expect(await linkedStagingFor(PROD_LINEAGE)).toBeNull();
  });

  it('flags rather than guesses when a production app has two candidate destinations', async () => {
    const report = await run();
    const flagged = report.flagged.map((c) => c.staging_app_id);
    expect(flagged).toContain(STAGING_AMBIG_A);
    expect(flagged).toContain(STAGING_AMBIG_B);
    expect(await linkedStagingFor(PROD_AMBIG)).toBeNull();
  });

  it('leaves an already-linked pair exactly as it found it', async () => {
    const report = await run();
    expect(report.skippedAlreadyLinked).toBeGreaterThanOrEqual(1);
    expect(await linkedStagingFor(PROD_LINKED)).toBe(STAGING_LINKED);
  });

  it('writes nothing at all in the default dry run', async () => {
    const report = await run({ dryRun: true });
    expect(report.wouldRelink.map((c) => c.staging_app_id)).toContain(STAGING_ORPHAN);
    expect(report.relinked).toHaveLength(0);
    expect(await linkedStagingFor(PROD_ORPHAN)).toBeNull();
  });

  it('is idempotent: a second live run relinks nothing new', async () => {
    await run();
    const second = await run();
    expect(second.relinked).toHaveLength(0);
    expect(await linkedStagingFor(PROD_ORPHAN)).toBe(STAGING_ORPHAN);
  });

  it('bounds its blast radius per run', async () => {
    const report = await run({ maxRelinksPerRun: 1 });
    expect(report.relinked.length).toBeLessThanOrEqual(1);
  });
});
