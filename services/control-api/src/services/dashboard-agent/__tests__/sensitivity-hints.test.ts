import { describe, it, expect } from 'vitest';
import { sensitivityFor, getToolCatalog } from '../tool-catalog.js';

describe('sensitivityFor honours ToolSpec hints', () => {
  it('still returns destructive for the explicit destructive cases', () => {
    expect(sensitivityFor('manage_app', { action: 'delete' })).toBe('destructive');
    expect(sensitivityFor('manage_billing', {})).toBe('destructive');
    expect(sensitivityFor('manage_migrations', { action: 'reverse' })).toBe('destructive');
  });

  it('falls back to the catalog hint instead of safe', () => {
    expect(sensitivityFor('manage_app', { action: 'update' })).toBe('confirm');
    expect(sensitivityFor('manage_repo', { action: 'link' })).toBe('confirm');
    expect(sensitivityFor('manage_migrations', { action: 'status' })).toBe('confirm');
  });

  it('leaves unhinted tools safe', () => {
    expect(sensitivityFor('query_audit_logs', {})).toBe('safe');
  });

  it('every catalog hint is a valid value', () => {
    for (const spec of getToolCatalog()) {
      if (spec.sensitivity !== undefined) {
        expect(['safe', 'confirm', 'destructive']).toContain(spec.sensitivity);
      }
    }
  });
});
