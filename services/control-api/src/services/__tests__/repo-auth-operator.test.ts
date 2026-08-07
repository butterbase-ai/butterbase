/**
 * `authorizeOperatorRepo` — the tenancy guard for the operator's IN-PROCESS
 * repo path.
 *
 * WHY A THIRD AUTHORIZER. The two existing ones both key off a HUMAN identity:
 * `authorizeRepoWrite` calls `AppResolver.resolveApp(…, requestUserId, …)` and
 * `authorizeRepoRead` falls back to it too. The autonomous operator has no
 * human identity — it runs as the `operator:<orgId>` sentinel, which is not a
 * Cognito sub and appears in no `organization_members` row. Handing that
 * sentinel to `AppResolver` would resolve nothing; handing it `null` would take
 * the public-visibility fallthrough. Neither is an authorization decision.
 *
 * So the operator gets its own authorizer whose ONLY question is the one it can
 * actually answer: does this app belong to the org this turn is running for?
 * That is precisely branch 1 of `AppResolver.resolveApp` ("app in caller's
 * active org"), and nothing else — no `owner_id` match, no membership
 * enumeration, and no public-visibility fallthrough.
 *
 * THE PUBLIC-VISIBILITY DECISION (pinned by the test below, deliberately).
 * `authorizeRepoRead` allows ANY caller — including an unauthenticated one — to
 * read the repo of an app with `visibility='public'`. That is right for a route
 * whose job is to serve a public template gallery to a browser. It is wrong
 * here for two reasons:
 *
 *   1. This authorizer gates a path that both READS AND WRITES. Hydration and
 *      flush share it. A read-only fallthrough that a write path also consults
 *      is one refactor away from being a write-anywhere hole, and the operator
 *      runs unattended with an org service key — there is no human to notice.
 *   2. The operator is not a visitor browsing a gallery. It is an agent acting
 *      ON an org's behalf, and hydrating some other org's public app into this
 *      org's working tree would let a subsequent flush write that org's files
 *      back out under an app the operator has no business touching.
 *
 * So: org membership or nothing. `visibility` is still RETURNED (the shape has
 * to match `RepoReadContext`), but it never decides anything.
 *
 * Every denial throws `AppNotFoundError`, matching the existing authorizers'
 * "don't leak existence" convention.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const runtimeQuery = vi.fn();

vi.mock('../runtime-db.js', () => ({
  getRuntimeDbPool: () => ({ query: runtimeQuery }),
}));

import { authorizeOperatorRepo } from '../repo-auth.js';
import { AppNotFoundError } from '../app-resolver.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const APP = 'app-1';

/** Control-plane pool stub: answers the single `org_app_index` lookup. */
function controlPool(rows: Array<{ region: string }>): Pool {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizeOperatorRepo', () => {
  it('allows an app whose runtime organization_id is the operator org', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ organization_id: ORG_A, visibility: 'private' }] });

    const ctx = await authorizeOperatorRepo(controlPool([{ region: 'us-east-1' }]), APP, ORG_A);

    expect(ctx).toEqual({ appId: APP, region: 'us-east-1', visibility: 'private', isOwner: true });
  });

  it('denies an app owned by a DIFFERENT org', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ organization_id: ORG_B, visibility: 'private' }] });

    await expect(
      authorizeOperatorRepo(controlPool([{ region: 'us-east-1' }]), APP, ORG_A),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  /**
   * THE PINNED DECISION. `authorizeRepoRead` would ALLOW this — the app is
   * public. This authorizer must not. If someone later "harmonises" the two by
   * copying the fallthrough over, this test is what fails.
   */
  it('denies another org\'s app even when it is visibility=public (no public fallthrough)', async () => {
    runtimeQuery.mockResolvedValue({ rows: [{ organization_id: ORG_B, visibility: 'public' }] });

    await expect(
      authorizeOperatorRepo(controlPool([{ region: 'us-east-1' }]), APP, ORG_A),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('denies when the app has no organization_id at all', async () => {
    // A null organization_id is unresolvable, not "belongs to everyone".
    runtimeQuery.mockResolvedValue({ rows: [{ organization_id: null, visibility: 'private' }] });

    await expect(
      authorizeOperatorRepo(controlPool([{ region: 'us-east-1' }]), APP, ORG_A),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('denies when the app is not in org_app_index', async () => {
    await expect(
      authorizeOperatorRepo(controlPool([]), APP, ORG_A),
    ).rejects.toBeInstanceOf(AppNotFoundError);
    expect(runtimeQuery).not.toHaveBeenCalled();
  });

  it('denies when the runtime apps row is missing', async () => {
    runtimeQuery.mockResolvedValue({ rows: [] });

    await expect(
      authorizeOperatorRepo(controlPool([{ region: 'us-east-1' }]), APP, ORG_A),
    ).rejects.toBeInstanceOf(AppNotFoundError);
  });

  /**
   * `operatorOrgIdFromUserId` returns null for the degenerate `operator:`
   * sentinel with no org. An unknown org must deny EVERYTHING rather than
   * matching whatever the app happens to say — and must do so before touching
   * a database, so a malformed identity cannot even enumerate app ids.
   */
  it('denies outright when the operator org is null, without querying', async () => {
    const pool = controlPool([{ region: 'us-east-1' }]);

    await expect(authorizeOperatorRepo(pool, APP, null)).rejects.toBeInstanceOf(AppNotFoundError);
    expect(pool.query).not.toHaveBeenCalled();
    expect(runtimeQuery).not.toHaveBeenCalled();
  });
});
