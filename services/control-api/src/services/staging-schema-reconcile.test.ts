/**
 * reconcileStagingSchema — DEFECT 2's fix.
 *
 * The live smoke test reached this through the feature's own supported flow:
 * drop a column in staging, promote (production correctly KEEPS it, because
 * promote never applies destructive DDL), then reset. The app-copy engine
 * reads production's column list and INSERTs it into staging verbatim, so
 * every row failed with `column "priority" of relation "notes" does not exist`
 * and the reset job went to `failed`. Nothing reconciled schema, so the state
 * could only be cleared by hand-written DDL on the staging database.
 *
 * Two things are load-bearing and are what this file tests:
 *   - DIRECTION. production -> staging, the inverse of promote. Reversed, this
 *     computes the DDL that makes PRODUCTION look like staging, and applies it
 *     to whichever pool it was handed.
 *   - ADDITIVE ONLY, AND HONEST ABOUT THE REST. A dropped column comes back; a
 *     changed column TYPE and a staging-only column do not, because both need
 *     destructive DDL against staging that reset is not entitled to choose on
 *     the user's behalf. Those must be REPORTED, never performed and never
 *     silently swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  introspectSchema: vi.fn(),
  applyMigration: vi.fn(),
}));

vi.mock('./schema-applier.js', () => ({ applyMigration: mocks.applyMigration }));
vi.mock('./schema-introspector.js', async (orig) => ({
  ...(await orig<typeof import('./schema-introspector.js')>()),
  introspectSchema: mocks.introspectSchema,
}));

import { reconcileStagingSchema } from './staging-schema-reconcile.js';

const prodPool = { query: vi.fn(), __tag: 'prod' } as never;
const stagingPool = { query: vi.fn(), __tag: 'staging' } as never;
const logger = { info: () => {}, warn: () => {} };

/** Introspection results keyed by which pool is being introspected. */
function schemas(prod: unknown, staging: unknown) {
  mocks.introspectSchema.mockImplementation(async (pool: unknown) =>
    pool === prodPool ? prod : staging);
}

const NOTES_WITH_PRIORITY = {
  tables: {
    notes: {
      columns: {
        id: { type: 'uuid', primaryKey: true },
        body: { type: 'text' },
        priority: { type: 'integer', nullable: true },
      },
    },
  },
};

const NOTES_WITHOUT_PRIORITY = {
  tables: {
    notes: {
      columns: {
        id: { type: 'uuid', primaryKey: true },
        body: { type: 'text' },
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyMigration.mockResolvedValue({ executedStatements: [] });
});

describe('reconcileStagingSchema', () => {
  it('re-adds a column staging dropped that production still has', async () => {
    schemas(NOTES_WITH_PRIORITY, NOTES_WITHOUT_PRIORITY);

    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });

    expect(mocks.applyMigration).toHaveBeenCalledTimes(1);
    const [pool, statements] = mocks.applyMigration.mock.calls[0];
    // Applied to STAGING. This is the assertion that fails if the direction
    // is ever inverted.
    expect(pool).toBe(stagingPool);
    expect(statements.map((s: { sql: string }) => s.sql).join('\n'))
      .toMatch(/ALTER TABLE "notes" ADD COLUMN "priority"/);
    expect(res.unreconciled).toEqual([]);
  });

  it('NEVER writes to production', async () => {
    schemas(NOTES_WITH_PRIORITY, NOTES_WITHOUT_PRIORITY);
    await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });
    // prodPool is read-only here: introspectSchema is the only thing it is
    // ever passed to, and that is mocked. A reversed direction would show up
    // as applyMigration being handed prodPool.
    for (const [pool] of mocks.applyMigration.mock.calls) {
      expect(pool).not.toBe(prodPool);
    }
  });

  it('applies nothing when the two schemas already agree', async () => {
    schemas(NOTES_WITH_PRIORITY, NOTES_WITH_PRIORITY);
    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });
    expect(mocks.applyMigration).not.toHaveBeenCalled();
    expect(res.applied).toEqual([]);
    expect(res.unreconciled).toEqual([]);
  });

  it('creates a whole table staging is missing', async () => {
    schemas(
      {
        tables: {
          notes: NOTES_WITH_PRIORITY.tables.notes,
          tags: { columns: { id: { type: 'uuid', primaryKey: true }, label: { type: 'text' } } },
        },
      },
      NOTES_WITH_PRIORITY,
    );
    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });
    expect(res.applied.map((s) => s.sql).join('\n')).toMatch(/CREATE TABLE "tags"/);
  });

  it('reports a column TYPE change as unreconciled instead of applying destructive DDL', async () => {
    // The exact shape the smoke test produced: staging changed `body` to
    // integer. Reconciling it would need ALTER COLUMN ... TYPE, which destroys
    // whatever staging holds there.
    schemas(
      NOTES_WITHOUT_PRIORITY,
      {
        tables: {
          notes: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              body: { type: 'integer' },
            },
          },
        },
      },
    );

    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });

    expect(res.unreconciled).toHaveLength(1);
    expect(res.unreconciled[0]).toMatch(/body/);
    // And the destructive statement was NOT handed to applyMigration.
    const applied = mocks.applyMigration.mock.calls
      .flatMap(([, statements]) => statements as { sql: string }[])
      .map((s) => s.sql).join('\n');
    expect(applied).not.toMatch(/ALTER COLUMN "body" TYPE/i);
  });

  it('reports a staging-only column rather than dropping it', async () => {
    schemas(
      NOTES_WITHOUT_PRIORITY,
      {
        tables: {
          notes: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              body: { type: 'text' },
              scratch: { type: 'text' },
            },
          },
        },
      },
    );

    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });

    expect(res.unreconciled.join('\n')).toContain('"notes"."scratch"');
    const applied = mocks.applyMigration.mock.calls
      .flatMap(([, statements]) => statements as { sql: string }[])
      .map((s) => s.sql).join('\n');
    expect(applied).not.toMatch(/DROP COLUMN/i);
  });

  it('reports a staging-only table rather than dropping it', async () => {
    schemas(
      NOTES_WITHOUT_PRIORITY,
      {
        tables: {
          notes: NOTES_WITHOUT_PRIORITY.tables.notes,
          scratchpad: { columns: { id: { type: 'uuid', primaryKey: true } } },
        },
      },
    );
    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });
    expect(res.unreconciled.join('\n')).toContain('table "scratchpad"');

    // ONE line about it, not two. diffSchema also emits an unauthorized
    // `DROP TABLE IF EXISTS "scratchpad" CASCADE` described as "use _drop to
    // remove it" — advice for someone editing a schema DSL file, which nobody
    // resetting a staging environment is doing. Reported verbatim it made the
    // job carry two warnings saying the same thing in different vocabularies
    // (seen live), which trains users to skim them.
    expect(res.unreconciled).toHaveLength(1);
    expect(res.unreconciled.join('\n')).not.toMatch(/_drop/);
  });

  it('returns production\'s table list, so the caller need not re-introspect', async () => {
    schemas(
      { tables: { notes: NOTES_WITHOUT_PRIORITY.tables.notes, tags: { columns: {} } } },
      NOTES_WITHOUT_PRIORITY,
    );
    const res = await reconcileStagingSchema({
      prodPool, stagingPool, stagingAppId: 'app_staging', logger,
    });
    expect(res.productionTables.sort()).toEqual(['notes', 'tags']);
  });
});
