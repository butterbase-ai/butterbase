import { describe, it, expect } from 'vitest';
import {
  MOVE_APP_RUNTIME_TABLES,
  MOVE_APP_RUNTIME_CHILD_TABLES,
  MOVE_APP_EXCLUDED,
  MOVE_APP_EXCLUDED_CHILD,
} from './runtime-tables.js';

describe('move-app runtime tables registry', () => {
  it('every child table\'s parent is a registered move-app parent', () => {
    const parents = new Set<string>(MOVE_APP_RUNTIME_TABLES);
    for (const c of MOVE_APP_RUNTIME_CHILD_TABLES) {
      expect(parents).toContain(c.parent);
    }
  });

  it('parent and excluded sets are disjoint', () => {
    const excluded = Object.keys(MOVE_APP_EXCLUDED);
    for (const e of excluded) {
      expect(MOVE_APP_RUNTIME_TABLES as readonly string[]).not.toContain(e);
    }
  });

  it('child and excluded-child sets are disjoint', () => {
    const excluded = Object.keys(MOVE_APP_EXCLUDED_CHILD);
    const childNames = MOVE_APP_RUNTIME_CHILD_TABLES.map((c) => c.table);
    for (const e of excluded) {
      expect(childNames).not.toContain(e);
    }
  });

  it('child entries have a non-empty parent_fk', () => {
    for (const c of MOVE_APP_RUNTIME_CHILD_TABLES) {
      expect(c.parent_fk).toBeTruthy();
      expect(c.parent_fk).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
  });

  it('every agent-feature child table is in MOVE_APP_RUNTIME_CHILD_TABLES', () => {
    // Smoke check against the four tables identified in the agent-feature
    // salvage move-app audit. If any of these drops off the registry, the
    // saga silently regresses on agent run history.
    const childNames = new Set<string>(MOVE_APP_RUNTIME_CHILD_TABLES.map((c) => c.table));
    expect(childNames.has('agent_checkpoints')).toBe(true);
    expect(childNames.has('agent_run_events')).toBe(true);
    expect(childNames.has('agent_usage')).toBe(true);
    expect(childNames.has('agent_webhook_deliveries')).toBe(true);
  });
});
