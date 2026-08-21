import { describe, it, expect, afterAll } from 'vitest';
import { createProjectForApp, projectNameForApp } from '../neon-client.js';
import { config } from '../../config.js';

const LIVE = process.env.NEON_LIVE_TEST === '1' && !!config.neon.apiKey;
const CONCURRENCY = 10;
const createdProjectIds: string[] = [];

async function deleteProject(id: string): Promise<number> {
  const res = await fetch(`https://console.neon.tech/api/v2/projects/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${config.neon.apiKey}` },
  });
  return res.status;
}

describe.skipIf(!LIVE)('Neon tenant project provisioning (live)', () => {
  afterAll(async () => {
    // Cleanup must run even if assertions failed — a leaked project bills forever.
    for (const id of createdProjectIds) {
      const status = await deleteProject(id);
      if (status !== 200 && status !== 404) {
        console.error(`[live-test] FAILED to delete project ${id}: HTTP ${status}`);
      }
    }
  });

  it(`creates ${CONCURRENCY} projects concurrently with zero conflicts`, async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        createProjectForApp({
          appId: `app_livetest${String(i).padStart(4, '0')}`,
          neonRegionId: 'aws-us-east-1',
          databaseName: `db_app_livetest${String(i).padStart(4, '0')}`,
          ownerRole: config.neon.databaseOwner,
        }),
      ),
    );

    for (const r of results) {
      if (r.status === 'fulfilled') createdProjectIds.push(r.value.projectId);
    }

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    // A 423 here means Neon started treating project creation as a conflicting
    // operation — the core assumption of the project-per-app design is broken.
    const conflicts = rejected.filter((r) => String(r.reason?.message ?? '').includes('423'));

    expect(conflicts).toHaveLength(0);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(CONCURRENCY);
  }, 120_000);

  it('names projects so the reconciler can find them', () => {
    expect(projectNameForApp('app_livetest0000')).toBe('bb-app_livetest0000');
  });
});
