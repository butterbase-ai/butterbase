/**
 * reconcileStagingSchema — DEFECT 2's fix, under the destructive-reconcile
 * ruling.
 *
 * The live smoke test reached this through the feature's own supported flow:
 * drop a column in staging, promote (production correctly KEEPS it, because
 * promote never applies destructive DDL), then reset. The app-copy engine
 * reads production's column list and INSERTs it into staging verbatim, so
 * every row failed with `column "priority" of relation "notes" does not exist`
 * and the reset job went to `failed`. Nothing reconciled schema, so the state
 * could only be cleared by hand-written DDL on the staging database.
 *
 * Reset is now entitled to DESTROY staging schema so that it always succeeds:
 * it drops staging-only tables and columns, rewrites diverged column types,
 * and matches constraints and defaults to production. Four things are
 * load-bearing and are what this file tests:
 *
 *   - DIRECTION. production -> staging, the inverse of promote. Reversed, this
 *     now computes AND EXECUTES the DDL that makes PRODUCTION look like
 *     staging — it would drop a customer's production columns.
 *   - PRODUCTION IS NEVER WRITTEN. `prodPool` is read-only: introspection only.
 *   - THE GUARDS RUN BEFORE THE DDL. Not merely earlier in the reset; before.
 *   - EVERY DESTRUCTION IS DISCLOSED. A user who loses a scratch table to a
 *     reset must learn it from the job record.
 *
 * Each destructive case below is a test that FAILS against the previous
 * additive-only behaviour, where `filterAdditive` withheld the statement and
 * the object survived.
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

import { reconcileStagingSchema, buildDesiredSchema } from './staging-schema-reconcile.js';

const prodPool = { query: vi.fn(), __tag: 'prod' } as never;
const stagingPool = { query: vi.fn(), __tag: 'staging' } as never;
const logger = { info: () => {}, warn: () => {} };

let assertCalls: number;
let assertStagingTarget: () => Promise<void>;

/** Introspection results keyed by which pool is being introspected. */
function schemas(prod: unknown, staging: unknown) {
  mocks.introspectSchema.mockImplementation(async (pool: unknown) =>
    pool === prodPool ? prod : staging);
}

/** Every statement handed to applyMigration, flattened to SQL. */
function appliedSql(): string {
  return mocks.applyMigration.mock.calls
    .flatMap(([, statements]) => statements as { sql: string }[])
    .map((s) => s.sql).join('\n');
}

function run() {
  return reconcileStagingSchema({
    prodPool, stagingPool, stagingAppId: 'app_staging', assertStagingTarget, logger,
  });
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
  assertCalls = 0;
  assertStagingTarget = async () => { assertCalls += 1; };
});

describe('reconcileStagingSchema — additive repair', () => {
  it('re-adds a column staging dropped that production still has', async () => {
    schemas(NOTES_WITH_PRIORITY, NOTES_WITHOUT_PRIORITY);
    await run();

    expect(mocks.applyMigration).toHaveBeenCalledTimes(1);
    const [pool] = mocks.applyMigration.mock.calls[0];
    // Applied to STAGING. The assertion that fails if the direction inverts.
    expect(pool).toBe(stagingPool);
    expect(appliedSql()).toMatch(/ALTER TABLE "notes" ADD COLUMN "priority"/);
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
    await run();
    expect(appliedSql()).toMatch(/CREATE TABLE "tags"/);
  });

  it('applies nothing, and destroys nothing, when the two schemas agree', async () => {
    schemas(NOTES_WITH_PRIORITY, NOTES_WITH_PRIORITY);
    const res = await run();
    expect(mocks.applyMigration).not.toHaveBeenCalled();
    expect(res.applied).toEqual([]);
    expect(res.destroyed).toEqual([]);
    // No DDL, no need to have asserted the target.
    expect(assertCalls).toBe(0);
  });
});

/**
 * One test per destructive case. Each of these FAILS against the additive-only
 * implementation, which withheld the statement via `filterAdditive` and left
 * the object in place — the state that made reset fail forever.
 */
describe('reconcileStagingSchema — destructive repair (staging only)', () => {
  it('DROPS a staging-only column', async () => {
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

    const res = await run();

    expect(appliedSql()).toMatch(/ALTER TABLE "notes" DROP COLUMN "scratch"/);
    expect(res.destroyed.join('\n')).toContain('dropped staging-only column "notes"."scratch"');
  });

  it('DROPS a staging-only table', async () => {
    schemas(
      NOTES_WITHOUT_PRIORITY,
      {
        tables: {
          notes: NOTES_WITHOUT_PRIORITY.tables.notes,
          scratchpad: { columns: { id: { type: 'uuid', primaryKey: true } } },
        },
      },
    );

    const res = await run();

    expect(appliedSql()).toMatch(/DROP TABLE IF EXISTS "scratchpad" CASCADE/);
    expect(res.destroyed.join('\n')).toContain('dropped staging-only table "scratchpad"');
    // Not the differ's "use _drop to remove it" phrasing, which is advice for
    // someone editing a schema DSL file — nobody resetting staging is.
    expect(res.destroyed.join('\n')).not.toMatch(/_drop/);
  });

  it('REWRITES a diverged column type', async () => {
    // The exact shape the smoke test produced: staging changed `body` to
    // integer, production still has text.
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

    const res = await run();

    expect(appliedSql()).toMatch(/ALTER TABLE "notes" ALTER COLUMN "body" TYPE text USING NULL::text/);
    expect(res.destroyed.join('\n')).toMatch(/rewrote column "notes"\."body" from integer to text/);
  });

  it('adds USING to every type rewrite — emptiness alone does NOT make the cast legal', async () => {
    // FOUND LIVE, after truncate-first ordering was in place and after every
    // unit test here was green: those mock applyMigration, so none of them
    // could ever have caught it. Postgres refuses ALTER COLUMN ... TYPE when
    // no ASSIGNMENT CAST exists between the two types. That is a check on the
    // TYPES, not the rows, so it fires on an EMPTY table too:
    //   ERROR: column "priority" cannot be cast automatically to type integer
    // `USING NULL::<type>` is valid for every type pair, and is lossless only
    // because the caller truncates first.
    schemas(
      { tables: { notes: { columns: { id: { type: 'uuid' }, priority: { type: 'integer' } } } } },
      { tables: { notes: { columns: { id: { type: 'uuid' }, priority: { type: 'text' } } } } },
    );

    const res = await run();

    const rewrite = res.applied.find((s) => /ALTER COLUMN "priority" TYPE/.test(s.sql))!;
    expect(rewrite.sql).toBe(
      'ALTER TABLE "notes" ALTER COLUMN "priority" TYPE integer USING NULL::integer',
    );
  });

  it('leaves statements that are not type rewrites untouched by the USING transform', async () => {
    schemas(
      NOTES_WITH_PRIORITY,
      NOTES_WITHOUT_PRIORITY,
    );
    const res = await run();
    for (const s of res.applied) {
      if (!/ALTER COLUMN "[^"]+" TYPE /.test(s.sql)) expect(s.sql).not.toMatch(/USING/);
    }
  });

  it('authorizes the type rewrite, or applyMigration would refuse it', async () => {
    // diffSchema emits a type change as `destructive: true, authorized: false`,
    // and applyMigration throws on exactly that combination. Without the
    // narrow override this statement could never execute.
    schemas(
      NOTES_WITHOUT_PRIORITY,
      { tables: { notes: { columns: { id: { type: 'uuid', primaryKey: true }, body: { type: 'integer' } } } } },
    );
    const res = await run();
    const rewrite = res.applied.find((s) => /ALTER COLUMN "body" TYPE/.test(s.sql));
    expect(rewrite).toBeDefined();
    expect(rewrite!.authorized).toBe(true);
  });

  it('does NOT blanket-authorize: a statement that is not a type rewrite keeps its flags', async () => {
    // The override is matched narrowly on purpose — a blanket
    // `authorized: true` would also authorize whatever destructive statement
    // the differ learns to emit next, silently.
    schemas(
      NOTES_WITHOUT_PRIORITY,
      {
        tables: {
          notes: NOTES_WITHOUT_PRIORITY.tables.notes,
          scratchpad: { columns: { id: { type: 'uuid', primaryKey: true } } },
        },
      },
    );
    const res = await run();
    const drop = res.applied.find((s) => /DROP TABLE/.test(s.sql))!;
    // Authorized STRUCTURALLY, via the differ's own `_drop` allow-list — not
    // by the TYPE_REWRITE override.
    expect(drop.authorized).toBe(true);
    expect(drop.sql).not.toMatch(/ALTER COLUMN/);
  });

  it('relaxes a constraint staging tightened, to match production', async () => {
    schemas(
      { tables: { notes: { columns: { id: { type: 'uuid', primaryKey: true }, body: { type: 'text', nullable: true } } } } },
      { tables: { notes: { columns: { id: { type: 'uuid', primaryKey: true }, body: { type: 'text', nullable: false } } } } },
    );
    const res = await run();
    expect(appliedSql()).toMatch(/ALTER TABLE "notes" ALTER COLUMN "body" DROP NOT NULL/);
    expect(res.destroyed.join('\n')).toMatch(/to match production/);
  });

  it('discloses every destroyed object, one line each', async () => {
    schemas(
      NOTES_WITHOUT_PRIORITY,
      {
        tables: {
          notes: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              body: { type: 'integer' },
              scratch: { type: 'text' },
            },
          },
          scratchpad: { columns: { id: { type: 'uuid', primaryKey: true } } },
        },
      },
    );

    const res = await run();
    const all = res.destroyed.join('\n');
    expect(all).toContain('dropped staging-only table "scratchpad"');
    expect(all).toContain('dropped staging-only column "notes"."scratch"');
    expect(all).toMatch(/rewrote column "notes"\."body"/);
  });
});

describe('reconcileStagingSchema — production is never the target', () => {
  it('NEVER hands production\'s pool to applyMigration', async () => {
    schemas(NOTES_WITH_PRIORITY, NOTES_WITHOUT_PRIORITY);
    await run();
    for (const [pool] of mocks.applyMigration.mock.calls) {
      expect(pool).not.toBe(prodPool);
      expect(pool).toBe(stagingPool);
    }
  });

  it('never issues a query on the production pool at all', async () => {
    // introspectSchema is mocked, so the ONLY way prodPool.query could be
    // called is if this module started writing through it.
    schemas(NOTES_WITH_PRIORITY, NOTES_WITHOUT_PRIORITY);
    await run();
    expect((prodPool as unknown as { query: { mock: { calls: unknown[] } } }).query.mock.calls)
      .toHaveLength(0);
  });

  it('asserts the staging target BEFORE any DDL executes', async () => {
    schemas(
      NOTES_WITHOUT_PRIORITY,
      { tables: { notes: NOTES_WITHOUT_PRIORITY.tables.notes, scratchpad: { columns: { id: { type: 'uuid' } } } } },
    );
    const order: string[] = [];
    assertStagingTarget = async () => { order.push('assert'); };
    mocks.applyMigration.mockImplementation(async () => {
      order.push('ddl');
      return { executedStatements: [] };
    });

    await run();

    expect(order).toEqual(['assert', 'ddl']);
  });

  it('executes NOTHING when the guard throws', async () => {
    schemas(
      NOTES_WITHOUT_PRIORITY,
      { tables: { notes: NOTES_WITHOUT_PRIORITY.tables.notes, scratchpad: { columns: { id: { type: 'uuid' } } } } },
    );
    assertStagingTarget = async () => {
      throw new Error('[staging-reset] refusing to alter schema: staging pool is connected to '
        + 'database "app_production", expected "app_staging"');
    };

    await expect(run()).rejects.toThrow(/refusing to alter schema/);
    expect(mocks.applyMigration).not.toHaveBeenCalled();
  });
});

describe('buildDesiredSchema', () => {
  it('authorizes removals through the differ\'s own allow-lists', async () => {
    const desired = buildDesiredSchema(
      NOTES_WITHOUT_PRIORITY as never,
      {
        tables: {
          notes: {
            columns: {
              id: { type: 'uuid', primaryKey: true },
              body: { type: 'text' },
              scratch: { type: 'text' },
            },
          },
          scratchpad: { columns: { id: { type: 'uuid' } } },
        },
      } as never,
    );
    expect(desired._drop).toEqual(['scratchpad']);
    expect((desired.tables as Record<string, { _dropColumns?: string[] }>).notes._dropColumns)
      .toEqual(['scratch']);
  });

  it('adds no allow-list entries when nothing is staging-only', async () => {
    const desired = buildDesiredSchema(
      NOTES_WITH_PRIORITY as never, NOTES_WITH_PRIORITY as never,
    );
    expect(desired._drop).toEqual([]);
    expect((desired.tables as Record<string, { _dropColumns?: string[] }>).notes._dropColumns)
      .toBeUndefined();
  });
});
