import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock config to include assertRegionConfig and runtimeDb
vi.mock('../../config.js', () => ({
  config: {
    cloudflare: {
      enabled: true,
      accountId: 'acct_test',
      apiToken: 'tok_test',
    },
    runtimeDb: { urlsByRegion: { 'us-east-1': 'postgres://localhost/runtime' } },
  },
  assertRegionConfig: vi.fn(() => ({ instanceRegion: 'us-east-1' })),
}));

// Capture the mock db so tests can inspect it
let mockRuntimeDb: ReturnType<typeof makeMockDb>['db'];

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: vi.fn(() => mockRuntimeDb),
}));

// fetchAndUpsert resolves the per-app runtime pool via region-resolver.
// Forward to the mock runtime db so its query.mock.calls capture the upserts.
vi.mock('../region-resolver.js', () => ({
  getRuntimeDbForApp: vi.fn(async () => mockRuntimeDb),
  resolveAppHomeRegion: vi.fn(async () => 'us-east-1'),
}));

vi.mock('../org-resolver.js', () => ({
  resolveOrganizationId: vi.fn(async () => 'org_1'),
}));

import { runAnalyticsPullerOnce } from '../cf-analytics-puller.js';

function makeMockDb() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  return {
    queries,
    db: {
      query: vi.fn(async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        // SELECT user_id FROM apps … returns the owner per app_id.
        if (text.includes('FROM apps')) {
          return { rows: [{ id: 'app_xyz', owner_id: 'user_1' }] };
        }
        return { rows: [] };
      }),
    } as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const m = makeMockDb();
  mockRuntimeDb = m.db;
});

describe('runAnalyticsPullerOnce', () => {
  it('queries CF GraphQL, attributes per script, writes to usage_meters', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            accounts: [
              {
                workersInvocationsAdaptive: [
                  {
                    dimensions: { scriptName: 'app_xyz_do' },
                    sum: {
                      requests: 42,
                      durationCpu: 1234, // ms
                    },
                  },
                  {
                    // A non-DO script — must be ignored.
                    dimensions: { scriptName: 'app_xyz' },
                    sum: { requests: 100, durationCpu: 999 },
                  },
                ],
              },
            ],
          },
        },
      }),
    });

    // runAnalyticsPullerOnce still accepts a db param (signature unchanged)
    // but all queries now go to runtimePool internally
    const m = makeMockDb();
    mockRuntimeDb = m.db;
    await runAnalyticsPullerOnce(m.db);

    const inserts = m.queries.filter((q) => q.text.includes('INSERT INTO usage_meters'));
    // One row per meter type for the matching app.
    const meters = inserts.map((q) => q.values[3]); // meter_type column (index 3 after organization_id at [1])
    expect(meters).toEqual(expect.arrayContaining(['do_requests', 'do_cpu_ms']));

    // The do_requests insert carries quantity 42.
    const reqInsert = inserts.find((q) => q.values[3] === 'do_requests');
    expect(reqInsert!.values).toEqual(
      expect.arrayContaining(['user_1', 'app_xyz', 'do_requests', expect.any(Number)]),
    );
  });

  it('skips when Cloudflare is disabled', async () => {
    // Re-mock config with enabled=false (vitest module reset).
    vi.resetModules();
    vi.doMock('../../config.js', () => ({
      config: {
        cloudflare: { enabled: false },
        runtimeDb: { urlsByRegion: {} },
      },
      assertRegionConfig: vi.fn(() => ({ instanceRegion: 'us-east-1' })),
    }));
    vi.doMock('../runtime-db.js', () => ({
      getRuntimeDbPool: vi.fn(() => mockRuntimeDb),
    }));
    const { runAnalyticsPullerOnce: runDisabled } = await import('../cf-analytics-puller.js');
    const m = makeMockDb();
    await runDisabled(m.db);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
