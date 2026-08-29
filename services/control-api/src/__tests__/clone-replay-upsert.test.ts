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
