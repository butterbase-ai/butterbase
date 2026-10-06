/**
 * Direct unit coverage of replayFrontend itself (clone-replay.ts), added for
 * Task 14 fix round 2 / finding I1.
 *
 * execute-promote.deploy.test.ts mocks replayFrontend wholesale, so its
 * "deploy failure fails the promote" tests pass whether or not the
 * `throwOnFailure` branch inside replayFrontend actually exists — a mutation
 * test confirmed this (`if (opts?.throwOnFailure)` -> `if (false)` left every
 * promote test green). These tests exercise the real function so the
 * rethrow — and the default soft-fail clone/update depend on — are each
 * pinned by an assertion, not just a code reading.
 *
 * Also covers I3: a bundle with zero occurrences of the source app id to
 * rewrite must surface as a job-visible warning when `warnOnZeroRewrite` is
 * set (promote), and must NOT change clone/update's default warnings shape
 * when it is omitted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AdmZip from 'adm-zip';
import type pg from 'pg';

const mocks = vi.hoisted(() => ({
  head: vi.fn(),
  copyObject: vi.fn(),
  getObjectAsBuffer: vi.fn(),
  putObject: vi.fn(),
  deployArtifact: vi.fn(),
}));

vi.mock('../r2.js', () => ({
  appArtifactKey: (appId: string) => `${appId}/app-artifact.zip`,
  head: mocks.head,
  copyObject: mocks.copyObject,
  getObjectAsBuffer: mocks.getObjectAsBuffer,
  putObject: mocks.putObject,
}));
vi.mock('../deployment.service.js', () => ({
  deployArtifact: mocks.deployArtifact,
}));

import { replayFrontend } from '../clone-replay.js';

function zipWithAppId(appId: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('index.js', Buffer.from(`const APP_ID = "${appId}"; // baked in at build time`));
  return zip.toBuffer();
}

function zipWithoutAnyAppId(): Buffer {
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<html><body>static, no app id baked in</body></html>'));
  return zip.toBuffer();
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const queryMock = vi.fn();
const destRuntimePool = { query: queryMock } as unknown as pg.Pool;
const controlDb = {} as pg.Pool;

const SOURCE_APP_ID = 'app_staging12345';
const DEST_APP_ID = 'app_prod123456ab';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.head.mockResolvedValue({ exists: true, contentLength: 100 });
  mocks.copyObject.mockResolvedValue(undefined);
  mocks.putObject.mockResolvedValue(undefined);
  mocks.getObjectAsBuffer.mockResolvedValue(zipWithAppId(SOURCE_APP_ID));
  mocks.deployArtifact.mockResolvedValue(undefined);
  queryMock.mockResolvedValue({ rows: [{ id: 'dep_1' }] });
});

async function run(opts?: Parameters<typeof replayFrontend>[6]) {
  return replayFrontend(controlDb, destRuntimePool, SOURCE_APP_ID, DEST_APP_ID, 'user_1', logger, opts);
}

describe('replayFrontend — default soft-fail contract (clone/update depend on this)', () => {
  it('captures a deploy failure as a warning and RESOLVES rather than throwing', async () => {
    mocks.deployArtifact.mockRejectedValueOnce(new Error('cf boom'));
    await expect(run()).resolves.toEqual({
      warnings: [expect.stringContaining('cf boom')],
    });
  });

  it('resolves with no warnings when everything succeeds', async () => {
    await expect(run()).resolves.toEqual({ warnings: [] });
  });
});

describe('replayFrontend — opts.throwOnFailure (the flag promote actually depends on)', () => {
  it('REJECTS with the underlying error instead of swallowing it', async () => {
    mocks.deployArtifact.mockRejectedValueOnce(new Error('cf boom'));
    await expect(run({ throwOnFailure: true })).rejects.toThrow('cf boom');
  });

  it('still resolves normally when the replay succeeds (the flag only changes the failure path)', async () => {
    await expect(run({ throwOnFailure: true })).resolves.toEqual({ warnings: [] });
  });

  it('rejects on an R2 failure too, not just a deployArtifact failure', async () => {
    mocks.copyObject.mockRejectedValueOnce(new Error('r2 copy failed'));
    await expect(run({ throwOnFailure: true })).rejects.toThrow('r2 copy failed');
  });
});

describe('replayFrontend — zero-rewrite bundle (I3)', () => {
  it('by default (no opts) does NOT add a warning for a zero-rewrite bundle — clone/update unaffected', async () => {
    mocks.getObjectAsBuffer.mockResolvedValue(zipWithoutAnyAppId());
    await expect(run()).resolves.toEqual({ warnings: [] });
  });

  it('with warnOnZeroRewrite, surfaces a job-visible warning naming the consequence', async () => {
    mocks.getObjectAsBuffer.mockResolvedValue(zipWithoutAnyAppId());
    const result = await run({ warnOnZeroRewrite: true });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(SOURCE_APP_ID);
    // Explicit about the consequence, not just "something happened" — a user
    // skimming warnings will not infer "production may hit the staging API".
    expect(result.warnings[0]).toMatch(/may still point at/i);
  });

  it('with warnOnZeroRewrite, does NOT warn when the bundle WAS rewritten', async () => {
    // Default mock already contains SOURCE_APP_ID, so filesRewritten > 0.
    const result = await run({ warnOnZeroRewrite: true });
    expect(result.warnings).toEqual([]);
  });
});
