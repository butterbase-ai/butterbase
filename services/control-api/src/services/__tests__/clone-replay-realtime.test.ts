import { describe, it, expect, vi } from 'vitest';
import { replayRealtimeConfig } from '../clone-replay.js';

// U18: clone copied app_realtime_config rows (runtime-plane metadata) but
// never installed the Postgres change-event trigger those rows describe, so
// every fresh clone landed with trigger_installed:false, drift:true and
// realtime events silently never fired. Fix: after replaying each enabled
// row, install the trigger on the dest app's own per-app DB (destAppPool) —
// same code path manage_realtime action=configure uses — and soft-fail into
// warnings[] (naming the still-drifted tables) instead of throwing.
//
// Unit-level with fake pg.Pool objects (no live DB in this sandbox): only
// `.query` is exercised, so a plain object with a vi.fn() stands in for a
// real pg.Pool.

const noopLogger = { info() {}, warn() {} };

function fakePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return { query } as any;
}

describe('replayRealtimeConfig', () => {
  it('installs the realtime trigger for each enabled table after replaying config rows', async () => {
    const sourceRows = [
      { table_name: 'orders', events: ['insert', 'update'], enabled: true },
      { table_name: 'archive', events: ['insert'], enabled: false },
    ];
    const sourceRuntimePool = fakePool(async () => ({ rows: sourceRows }));
    const destRuntimeQuery = vi.fn(async () => ({ rows: [] }));
    const destRuntimePool = fakePool(destRuntimeQuery);
    const installCalls: string[] = [];
    const destAppPool = fakePool(async (_sql, params) => {
      installCalls.push(String(params?.[0]));
      return { rows: [] };
    });

    const warnings: string[] = [];
    await replayRealtimeConfig(
      sourceRuntimePool, destRuntimePool, destAppPool, 'app_src', 'app_dst', warnings, noopLogger, false,
    );

    // Only the enabled table gets its trigger installed.
    expect(installCalls).toEqual(['orders']);
    // Config rows for BOTH tables (enabled and disabled) are still replayed.
    expect(destRuntimeQuery).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
  });

  it('does not throw when trigger install fails, and warns naming only the drifted tables', async () => {
    const sourceRows = [
      { table_name: 'orders', events: ['insert'], enabled: true },
      { table_name: 'invoices', events: ['insert'], enabled: true },
    ];
    const sourceRuntimePool = fakePool(async () => ({ rows: sourceRows }));
    const destRuntimePool = fakePool(async () => ({ rows: [] }));
    const destAppPool = fakePool(async (_sql, params) => {
      if (params?.[0] === 'invoices') throw new Error('permission denied for schema realtime');
      return { rows: [] };
    });

    const warnings: string[] = [];
    await expect(
      replayRealtimeConfig(
        sourceRuntimePool, destRuntimePool, destAppPool, 'app_src', 'app_dst', warnings, noopLogger, false,
      ),
    ).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('invoices');
    expect(warnings[0]).not.toContain('orders');
  });

  it('skips trigger install for disabled rows and for rows whose config insert failed', async () => {
    const sourceRows = [
      { table_name: 'disabled_table', events: ['insert'], enabled: false },
      { table_name: 'bad_insert', events: ['insert'], enabled: true },
    ];
    const sourceRuntimePool = fakePool(async () => ({ rows: sourceRows }));
    const destRuntimePool = fakePool(async (_sql, params) => {
      if (params?.[1] === 'bad_insert') throw new Error('duplicate key value');
      return { rows: [] };
    });
    const installCalls: string[] = [];
    const destAppPool = fakePool(async (_sql, params) => {
      installCalls.push(String(params?.[0]));
      return { rows: [] };
    });

    const warnings: string[] = [];
    await replayRealtimeConfig(
      sourceRuntimePool, destRuntimePool, destAppPool, 'app_src', 'app_dst', warnings, noopLogger, false,
    );

    expect(installCalls).toEqual([]);
    // The row-level insert failure warning still fires (pre-existing behavior).
    expect(warnings.some((w) => w.includes('bad_insert'))).toBe(true);
    // No drift warning, since no table successfully replayed AND enabled.
    expect(warnings.filter((w) => w.includes('drift'))).toHaveLength(0);
  });
});
