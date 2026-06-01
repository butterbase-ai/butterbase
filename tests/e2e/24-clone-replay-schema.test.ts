/**
 * E2E — Phase 5 / Task A1: clone worker replays source schema onto dest DB.
 *
 * Seeds a source app (us-east-1) with a `posts` + `comments` table, marks it
 * public+listed, pushes a snapshot, starts a clone, waits for completion, then
 * asserts the dest DB has both tables with the same columns.
 *
 * Drives control-api at http://localhost:4000.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

import {
  CONTROL_DB_URL,
  RUNTIME_DB_URL_US,
  seedUserAndApp,
  applySchemaAsOwner,
  waitForCloneStep,
  waitForProvisioning,
  pushSnapshot,
} from './helpers/templates.js';

const API_URL = 'http://localhost:4000';

let controlPool: pg.Pool;
let runtimePool: pg.Pool;

beforeAll(async () => {
  controlPool = new pg.Pool({ connectionString: CONTROL_DB_URL });
  runtimePool = new pg.Pool({ connectionString: RUNTIME_DB_URL_US });

  // Sanity: control-api reachable.
  const health = await fetch(`${API_URL}/health`);
  if (!health.ok) {
    throw new Error(`control-api /health unreachable at ${API_URL} — status ${health.status}`);
  }
  // Confirm clone routes registered.
  const probe = await fetch(`${API_URL}/v1/clone-jobs/cj_doesnotexist`, {
    headers: { Authorization: 'Bearer bb_sk_invalid' },
  });
  if (probe.status !== 401 && probe.status !== 404) {
    throw new Error(`/v1/clone-jobs/:id probe returned unexpected ${probe.status}`);
  }
}, 30_000);

afterAll(async () => {
  await controlPool?.end();
  await runtimePool?.end();
}, 30_000);

describe('Phase 5 A1 — clone worker replays source schema onto dest', () => {
  it('dest DB has same tables+columns as source after clone completes', async () => {
    // 1. Create source app via the real init route (provisions an actual DB).
    //    We use a fresh user created via seedUserAndApp to own the source.
    const sourceOwner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'sreplay-src');

    const sourceInitRes = await fetch(`${API_URL}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'schema-replay-source' }),
    });
    if (!sourceInitRes.ok) {
      throw new Error(
        `POST /init for source failed: ${sourceInitRes.status} ${await sourceInitRes.text()}`,
      );
    }
    const sourceInitBody = await sourceInitRes.json() as { app_id: string };
    const sourceAppId = sourceInitBody.app_id;

    // 2. Wait for the source app's DB to be provisioned.
    await waitForProvisioning(sourceOwner.apiKey, sourceAppId, 120_000);

    // 3. Mark source public+listed.
    const patchRes = await fetch(`${API_URL}/v1/${sourceAppId}/config/visibility`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sourceOwner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public', listed: true }),
    });
    expect(patchRes.status, await patchRes.clone().text()).toBe(200);

    // 4. Apply schema — posts + comments.
    const schemaDsl = {
      tables: {
        posts: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            title: { type: 'text', nullable: false },
            body: { type: 'text' },
            created_at: { type: 'timestamptz', default: 'now()' },
          },
        },
        comments: {
          columns: {
            id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
            post_id: { type: 'uuid', references: 'posts.id' },
            content: { type: 'text', nullable: false },
            created_at: { type: 'timestamptz', default: 'now()' },
          },
        },
      },
    };
    await applySchemaAsOwner(sourceOwner.apiKey, sourceAppId, schemaDsl);

    // 5. Push a snapshot (required for clone to proceed).
    await pushSnapshot(sourceOwner.apiKey, sourceAppId, '# schema-replay source\n');

    // 6. Create a cloner user + clone.
    const cloner = await seedUserAndApp(controlPool, runtimePool, 'us-east-1', 'sreplay-cln');

    const cloneRes = await fetch(`${API_URL}/v1/templates/${sourceAppId}/clone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cloner.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'schema-replay-dest' }),
    });
    expect(cloneRes.status, await cloneRes.clone().text()).toBe(200);
    const cloneBody = await cloneRes.json() as { job_id: string; status: string };
    expect(cloneBody.job_id).toMatch(/^cj_/);

    // 7. Wait for the clone job to reach 'completed' (or 'failed').
    const final = await waitForCloneStep(
      cloner.apiKey,
      cloneBody.job_id,
      ['completed', 'failed'],
      120_000,
    );
    expect(final.status, `Clone job ended with unexpected status: ${JSON.stringify(final)}`).toBe('completed');
    expect(final.dest_app_id).toBeTruthy();

    const destAppId = final.dest_app_id!;

    // 8. Verify dest schema has both tables with correct columns.
    //    GET /v1/:app_id/schema — cloner owns the dest.
    const destSchemaRes = await fetch(`${API_URL}/v1/${destAppId}/schema`, {
      headers: { Authorization: `Bearer ${cloner.apiKey}` },
    });
    expect(destSchemaRes.status, await destSchemaRes.clone().text()).toBe(200);
    const destSchemaBody = await destSchemaRes.json() as {
      schema: { tables: Record<string, { columns: Record<string, unknown> }> };
    };

    const { tables } = destSchemaBody.schema;

    // Both tables must be present.
    expect(
      Object.keys(tables),
      `dest schema tables=${JSON.stringify(Object.keys(tables))} — expected posts+comments`,
    ).toContain('posts');
    expect(Object.keys(tables)).toContain('comments');

    // posts columns: id, title, body, created_at.
    const postsCols = Object.keys(tables.posts?.columns ?? {});
    expect(postsCols).toContain('id');
    expect(postsCols).toContain('title');
    expect(postsCols).toContain('body');
    expect(postsCols).toContain('created_at');

    // comments columns: id, post_id, content, created_at.
    const commentsCols = Object.keys(tables.comments?.columns ?? {});
    expect(commentsCols).toContain('id');
    expect(commentsCols).toContain('post_id');
    expect(commentsCols).toContain('content');
    expect(commentsCols).toContain('created_at');
  }, 300_000);
});

