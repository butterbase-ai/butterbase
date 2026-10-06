/**
 * Pins the deliberate decision (2026-08-05) that `ToolSpec.sensitivity` hints
 * are INERT: `sensitivityFor` computes its verdict solely from the explicit
 * name+args destructive rules, and everything else is 'safe'. The 'confirm'
 * tier is unused for now.
 *
 * The `'safe'` expectations below are the CHOSEN CONTRACT, not an accident.
 * Honouring the hints would gate 26 (tool, action) pairs behind an approval
 * modal, including read-only calls such as the `manage_app` action="list" that
 * opens every conversation. The hints stay in the catalog because this is
 * expected to be revisited; if that happens, these assertions are what should
 * change first.
 */
import { describe, it, expect } from 'vitest';
import { sensitivityFor, getToolCatalog } from '../tool-catalog.js';

describe('sensitivityFor', () => {
  it('returns destructive for the explicit destructive cases', () => {
    expect(sensitivityFor('manage_app', { action: 'delete' })).toBe('destructive');
    expect(sensitivityFor('manage_app', { action: 'pause' })).toBe('destructive');
    expect(sensitivityFor('manage_repo', { action: 'wipe' })).toBe('destructive');
    expect(sensitivityFor('manage_billing', {})).toBe('destructive');
    expect(sensitivityFor('manage_migrations', { action: 'abort' })).toBe('destructive');
    expect(sensitivityFor('manage_migrations', { action: 'reverse' })).toBe('destructive');
    expect(
      sensitivityFor('manage_schema', { action: 'apply', schema: 'DROP TABLE posts;' }),
    ).toBe('destructive');
  });

  it('does NOT honour the catalog sensitivity hint — hinted tools stay safe', () => {
    // manage_app, manage_repo and manage_migrations all declare
    // sensitivity: 'confirm' in the catalog. That hint is intentionally ignored.
    expect(sensitivityFor('manage_app', { action: 'update' })).toBe('safe');
    expect(sensitivityFor('manage_app', { action: 'list' })).toBe('safe');
    expect(sensitivityFor('manage_repo', { action: 'link' })).toBe('safe');
    expect(sensitivityFor('manage_repo', { action: 'status' })).toBe('safe');
    expect(sensitivityFor('manage_migrations', { action: 'status' })).toBe('safe');
    expect(sensitivityFor('manage_migrations', { action: 'get_active' })).toBe('safe');
  });

  it('leaves unhinted tools safe', () => {
    expect(sensitivityFor('query_audit_logs', {})).toBe('safe');
    expect(sensitivityFor('select_rows', { action: 'select' })).toBe('safe');
  });

  it('never returns confirm — the tier is deliberately unused', () => {
    for (const spec of getToolCatalog()) {
      for (const args of [{}, { action: 'list' }, { action: 'update' }, { action: 'get' }]) {
        expect(sensitivityFor(spec.name, args)).not.toBe('confirm');
      }
    }
  });

  it('every catalog hint is a valid value', () => {
    for (const spec of getToolCatalog()) {
      if (spec.sensitivity !== undefined) {
        expect(['safe', 'confirm', 'destructive']).toContain(spec.sensitivity);
      }
    }
  });
});
