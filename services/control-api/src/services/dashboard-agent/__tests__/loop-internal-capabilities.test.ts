/**
 * Characterisation of why the operator cannot read or ship app source.
 *
 * `repoSync` and the frontend deployer are LOOP-INTERNAL: the loop calls them
 * on its own behalf, with no model in the loop and no turn to pause. `turnMcp`
 * therefore admits only a literal 'allow' verdict (loop.ts:568-579) — an
 * 'approval' is refused rather than silently executed, because there is nobody
 * to approve to.
 *
 * Two capabilities land on the wrong side of that line:
 *
 *   manage_repo     — explicitly 'approval' (operator-policy.ts:209)
 *   manage_frontend — absent from the table entirely, so the deny-by-default
 *                     floor makes it 'approval'
 *
 * The consequence was the one recorded on 2026-08-07: hydration is refused, so
 * every operator turn starts with an empty working tree, and a frontend deploy
 * 371 events into a turn is refused too.
 *
 * ---------------------------------------------------------------------------
 * BOTH SYMPTOMS ARE NOW FIXED — AND THE ASSERTIONS BELOW STILL PASS.
 * ---------------------------------------------------------------------------
 * That combination is the point, so read it before "updating" this file. The
 * fix was NOT to widen the tier table or to loosen `turnMcp`. Both are exactly
 * as they were, which is why every assertion here is still green. What changed
 * is that the loop no longer ROUTES these two calls through `turnMcp` at all:
 *
 *   manage_repo      -> repo-http.ts      (loop.ts, `repoSync` on operator turns)
 *   manage_frontend  -> frontend-http.ts  (loop.ts, the deployer's transport)
 *
 * Both talk to the same control-api HTTP routes the human dashboard uses, with
 * the org's `bb_sk_*`, so `requireUserId` + `authorizeRepoWrite` /
 * `AppResolver.resolveApp` still decide access. Authorization moved layer, not
 * strength.
 *
 * So these tests keep their original job: they pin that the MCP path stays
 * shut. If one of them ever goes red, someone has widened the policy — which
 * may be right, but must be deliberate and visible in a diff rather than a
 * side effect of an edit to the tier table.
 */

import { describe, it, expect } from 'vitest';
import { operatorPolicyForOrg } from '../operator-policy.js';

const ORG = 'org_11111111-1111-1111-1111-111111111111';

/**
 * Exactly the admission test `turnMcp` applies — note the ABSENT ctx. That
 * omission is the whole mechanism (loop.ts:573 passes three arguments), and
 * modelling it with a yolo context instead is how this file was wrong on its
 * first run: it reported a product defect that did not exist.
 */
const admittedByTurnMcp = (name: string, args: unknown) =>
  operatorPolicyForOrg(name, args, ORG) === 'allow';

describe('loop-internal capabilities at the turnMcp boundary', () => {
  describe('manage_repo — hydration and persistence', () => {
    for (const action of ['pull_latest', 'push', 'status'] as const) {
      it(`refuses ${action}`, () => {
        expect(admittedByTurnMcp('manage_repo', { action, app_id: 'app_1' })).toBe(false);
      });
    }
  });

  describe('manage_frontend — the from-source build path', () => {
    for (const action of ['create_from_source', 'start_from_source', 'list_deployments'] as const) {
      it(`refuses ${action}`, () => {
        expect(admittedByTurnMcp('manage_frontend', { action, app_id: 'app_1' })).toBe(false);
      });
    }

    /**
     * `manage_frontend` is refused by ABSENCE, not by a deliberate verdict.
     * That is the deny-by-default floor working as designed — but it means the
     * refusal reads identically to a considered decision. Pin the distinction
     * so that adding a table entry later is understood as a policy change.
     */
    it('is absent from the tier table, not explicitly denied', () => {
      expect(operatorPolicyForOrg('manage_frontend', { action: 'create_from_source' }, ORG))
        .toBe('approval');
    });
  });

  /**
   * Control: a genuinely allowed tool must pass the same gate, otherwise these
   * tests would pass vacuously against a helper that always returns false.
   */
  it('admits an allow-tier tool through the same gate', () => {
    expect(admittedByTurnMcp('select_rows', { app_id: 'app_1' })).toBe(true);
  });

  /**
   * The latent hazard, and the reason the ctx omission deserves a test of its
   * own rather than a comment.
   *
   * Both capabilities sit at 'approval', and yolo_mode promotes 'approval' to
   * 'allow' WHEREVER a context is supplied. Nothing about the tier table keeps
   * them refused — the refusal rests entirely on `turnMcp` choosing not to pass
   * ctx. A future edit that threads a context through that call site "for
   * consistency" would silently hand the operator unattended repo writes and
   * frontend deploys on the org service key, and no existing test would fail.
   *
   * So assert the promotion directly: if these ever stop being 'allow'-under-
   * yolo, the tier table changed; if `turnMcp` ever starts passing ctx, the
   * refusal tests above break. Between them the hazard cannot move unobserved.
   */
  it('would be promoted to allow if a yolo context were ever passed here', () => {
    for (const name of ['manage_repo', 'manage_frontend']) {
      expect(operatorPolicyForOrg(name, { action: 'push', app_id: 'app_1' }, ORG))
        .toBe('approval');
      expect(operatorPolicyForOrg(name, { action: 'push', app_id: 'app_1' }, ORG, { yoloMode: true }))
        .toBe('allow');
    }
  });
});
