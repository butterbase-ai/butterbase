import { describe, it, expect } from 'vitest';
import { filterAdditive } from '../services/schema-additive-filter.js';
import type { DDLStatement } from '../services/schema-differ.js';

const stmt = (sql: string, destructive = false, authorized = true): DDLStatement =>
  ({ sql, description: sql, destructive, authorized });

describe('filterAdditive', () => {
  it('keeps creates and adds', () => {
    const input = [
      stmt('CREATE TABLE "posts" ("id" text)'),
      stmt('ALTER TABLE "posts" ADD COLUMN "title" text'),
      stmt('CREATE INDEX "idx_posts_title" ON "posts" ("title")'),
    ];
    expect(filterAdditive(input).kept).toHaveLength(3);
    expect(filterAdditive(input).rejected).toHaveLength(0);
  });

  it('rejects DROP TABLE even though it is flagged unauthorized', () => {
    const input = [stmt('DROP TABLE IF EXISTS "fork_only" CASCADE', true, false)];
    expect(filterAdditive(input).kept).toHaveLength(0);
    expect(filterAdditive(input).rejected).toHaveLength(1);
  });

  it('rejects DROP COLUMN', () => {
    const input = [stmt('ALTER TABLE "posts" DROP COLUMN "extra"', true, true)];
    expect(filterAdditive(input).kept).toHaveLength(0);
  });

  // The case a flag-based filter would miss: diffSchema emits index drops
  // with destructive:false, authorized:true.
  it('rejects DROP INDEX despite destructive:false', () => {
    const input = [stmt('DROP INDEX IF EXISTS "idx_fork_only"', false, true)];
    expect(filterAdditive(input).kept).toHaveLength(0);
    expect(filterAdditive(input).rejected).toHaveLength(1);
  });

  it('rejects ALTER COLUMN TYPE, which can lose data', () => {
    const input = [stmt('ALTER TABLE "posts" ALTER COLUMN "n" TYPE integer', true, false)];
    expect(filterAdditive(input).kept).toHaveLength(0);
  });

  it('rejects compound statement with DROP hidden after additive prefix', () => {
    const input = [
      stmt(
        'ALTER TABLE "posts" ALTER COLUMN "n" SET DEFAULT 0; DROP TABLE users; --',
        true,
        false,
      ),
    ];
    expect(filterAdditive(input).kept).toHaveLength(0);
    expect(filterAdditive(input).rejected).toHaveLength(1);
  });

  it('rejects lowercase drop table', () => {
    const input = [stmt('drop table "x"', true, false)];
    expect(filterAdditive(input).kept).toHaveLength(0);
    expect(filterAdditive(input).rejected).toHaveLength(1);
  });

  it('keeps plain additive ALTER COLUMN SET DEFAULT', () => {
    const input = [stmt('ALTER TABLE "posts" ALTER COLUMN "n" SET DEFAULT 0', false, true)];
    expect(filterAdditive(input).kept).toHaveLength(1);
    expect(filterAdditive(input).rejected).toHaveLength(0);
  });
});
