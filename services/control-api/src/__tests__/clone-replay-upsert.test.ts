import { describe, it, expect } from 'vitest';
import { buildFunctionInsertSql, buildTriggerInsertSql } from '../services/clone-replay.js';

describe('function replay conflict clause', () => {
  it('skips existing functions when not overwriting (clone)', () => {
    expect(buildFunctionInsertSql(false)).toMatch(/ON CONFLICT \(app_id, name\) DO NOTHING/);
  });

  it('updates existing functions when overwriting (update)', () => {
    const sql = buildFunctionInsertSql(true);
    expect(sql).toMatch(/ON CONFLICT \(app_id, name\) DO UPDATE/);
    expect(sql).toMatch(/code\s*=\s*EXCLUDED\.code/);
  });

  it('skips existing triggers when not overwriting (clone)', () => {
    expect(buildTriggerInsertSql(false))
      .toMatch(/ON CONFLICT \(function_id, trigger_type\) DO NOTHING/);
  });

  it('updates existing triggers when overwriting', () => {
    const sql = buildTriggerInsertSql(true);
    expect(sql).toMatch(/ON CONFLICT \(function_id, trigger_type\) DO UPDATE/);
    expect(sql).toMatch(/trigger_config\s*=\s*EXCLUDED\.trigger_config/);
    expect(sql).toMatch(/enabled\s*=\s*EXCLUDED\.enabled/);
  });
});

/**
 * The promote path's trigger contract.
 *
 * isolateStagingApp (staging-isolation.ts) deliberately sets every cron trigger
 * on a staging app to `enabled = false`, so a staging environment does not fire
 * scheduled work at real integrations. The overwrite conflict clause above
 * copies `enabled` from the source row — so a promote from staging would carry
 * that `false` onto the customer's LIVE production app and silently switch off
 * every nightly billing, cleanup and digest job.
 *
 * These assert the mechanism directly: whether `enabled` appears in the
 * DO UPDATE SET list is exactly what decides whether production keeps its own
 * on/off state. (A live-Postgres behavioural test would be better still, but DB
 * tests in this repo are gated behind RUN_DB_TESTS and skipped by default; the
 * SQL is the whole of the behaviour here, and executePromote's own suite pins
 * that the flag is actually passed.)
 */
describe('trigger replay: preserveDestinationEnabled (promote)', () => {
  it('keeps the destination enabled flag while still updating the schedule', () => {
    const sql = buildTriggerInsertSql(true, true);
    expect(sql).toMatch(/ON CONFLICT \(function_id, trigger_type\) DO UPDATE/);
    // The schedule still travels...
    expect(sql).toMatch(/trigger_config\s*=\s*EXCLUDED\.trigger_config/);
    // ...but the on/off half must NOT be written from the source. A production
    // trigger at enabled = true stays true even though staging's is false.
    expect(sql).not.toMatch(/enabled\s*=\s*EXCLUDED\.enabled/);
  });

  it('is inert without overwriteExisting, so clone still does nothing on conflict', () => {
    expect(buildTriggerInsertSql(false, true))
      .toMatch(/ON CONFLICT \(function_id, trigger_type\) DO NOTHING/);
  });

  // clone-replay.ts is shared and shipped: clone, staging_create and the
  // template-update path must be byte-identical to before the flag existed.
  it('defaults off, producing byte-identical SQL for every existing caller', () => {
    expect(buildTriggerInsertSql(true, false)).toBe(buildTriggerInsertSql(true));
    expect(buildTriggerInsertSql(false, false)).toBe(buildTriggerInsertSql(false));
  });
});
