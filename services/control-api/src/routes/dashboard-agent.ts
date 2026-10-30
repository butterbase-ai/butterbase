/**
 * Dashboard Assistant HTTP routes.
 *
 * Endpoints:
 *   POST   /conversations          – create a conversation
 *   GET    /conversations          – list caller's conversations
 *   GET    /conversations/:id      – get conversation + messages
 *   DELETE /conversations/:id      – delete conversation (204)
 *   PATCH  /conversations/:id/rename    – rename conversation (user-chosen title)
 *   POST   /conversations/:id/duplicate – copy conversation + all messages
 *   POST   /conversations/:id/pin       – set/clear pinned_at
 *   POST   /messages               – SSE agent turn (streams LoopEvent frames)
 *   POST   /conversations/:id/regenerate – regenerate an assistant reply, or
 *          edit-and-resend a user message ({message_id, new_user_message?}).
 *          Deletes the target message + everything after it, then streams a
 *          fresh turn via SSE (same wire format as /messages).
 *   POST   /messages/:id/rate      – set/clear a thumbs up/down + optional
 *          reason on an assistant message ({rating: 1|-1|0, reason?}).
 *   POST   /conversations/:id/rewind – restore working tree to a prior snapshot
 *   GET    /conversations/:id/snapshots – list snapshot history + labels
 *   POST   /conversations/:id/snapshots/label – set a user label on a snapshot
 *   POST   /v1/dashboard-agent/approvals/:id/resolve – approve/deny a gated
 *          tool call and stream the resumed turn's SSE events. Combines the
 *          approve/deny + resume-and-execute steps described in the Plan 3b
 *          Task 3 brief into a single endpoint (documented choice — see brief
 *          "For simplicity ... pick and document").
 *   GET    /operator/approvals/:id – one approval, resolved or pending, for
 *          smoke/ops checks that must observe a resolution (no transcript).
 *   GET    /operator/approvals/:id/conversation – the prose window up to the
 *          approval's turn (no tool rows, args or results).
 *   GET    /operator/approvals – pending approvals raised by the headless
 *          operator for the caller's org (org-scoped, membership-checked).
 *   POST   /operator/approvals/:id/resolve – approve/deny one of those.
 *
 * Feature flag: DASHBOARD_ASSISTANT_ENABLED must equal '1' or all routes
 * return 404.
 *
 * Auth: uses app.controlDb (pg.Pool) and requireUserId(request) which reads
 * request.auth.userId populated by the auth plugin (see plugins/auth.ts).
 *
 * Pool: app.controlDb (decorated by plugins/database.ts).
 */

import { buildProposalReview, verifyPreparedApproval } from '../services/dashboard-agent/proposal-review.js';
import { redactProposalArguments } from '../services/dashboard-agent/approval-proposal.js';
import { validateProposalToolArguments } from '../services/dashboard-agent/proposal-validation.js';
import { readConfirmedExecution } from '../services/dashboard-agent/execution-outcome.js';
import { requestApprovalReview } from '../services/dashboard-agent/request-proposal-review.js';
import { listRecentResolvedByOrg, type OrgApproval } from '../services/dashboard-agent/approvals-store.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { DEFAULT_ASSISTANT_MODEL, resolveAssistantModel } from '../services/dashboard-agent/assistant-model.js';
import { requireUserId } from '../utils/require-auth.js';
import {
  createConversation,
  listConversations,
  getConversation,
  isOfficeClientConversation,
  deleteConversation,
  updateConversationModel,
  renameConversation,
  duplicateConversation,
  pinConversation,
  listMessages,
  appendMessage,
  listSnapshotLabels,
  upsertSnapshotLabel,
  getMessageById,
  deleteMessagesFromInclusive,
  getLastUserMessage,
  getMessageWithOwner,
  rateMessage,
  type SnapshotLabel,
} from '../services/dashboard-agent/store.js';
import { runAgentTurn, getSharedWorkingTreeCache } from '../services/dashboard-agent/loop.js';
import { publish as publishEvent, subscribe as subscribeToConversation } from '../services/dashboard-agent/event-bus.js';
import { getRecentAppIds } from '../services/dashboard-agent/schema-context.js';
import { listUsage, getConversationUsageTotal } from '../services/dashboard-agent/usage-store.js';
import { createRepoSync } from '../services/dashboard-agent/repo-sync.js';
import { callMcpTool } from '../services/dashboard-agent/mcp-client.js';
import {
  resolveApprovalAndPersistResult,
  completeApprovalResolution,
  type ApprovalExecutor,
} from '../services/dashboard-agent/resume.js';
import {
  getApproval,
  getApprovalForOrg,
  listPendingByOrg,
} from '../services/dashboard-agent/approvals-store.js';
import { listApprovalConversation } from '../services/dashboard-agent/approval-conversation.js';
import {
  executeApprovedOperatorTool,
  rejectEscalatedSubstrateAction,
} from '../services/dashboard-agent/substrate-approval-bridge.js';
import { getSharedDeployTreeStore } from '../services/dashboard-agent/deploy-tree-store.js';
import { evaluateOperatorAccess } from '../services/dashboard-agent/operator-access-policy.js';
// TEMPORARY — dev-mode operator trace viewer. Delete with GET /operator/traces.
import { operatorUserId } from '../services/dashboard-agent/operator-store.js';
import { listOperatorTraces } from '../services/dashboard-agent/operator-traces.js';
import type {
  IntegrationReader, SkillCreatorExecutor,
} from '../services/dashboard-agent/skill-types.js';

// ---------------------------------------------------------------------------
// Feature-flag guard
// ---------------------------------------------------------------------------

function isEnabled(): boolean {
  return process.env.DASHBOARD_ASSISTANT_ENABLED === '1';
}

// The dashboard forwards the user's active org as `x-organization-id`. The
// agent loop uses it to scope app-discovery tooling (manage_app list) to the
// current org. Absent / non-string → null (loop falls back to unscoped).
function readOrgId(request: { headers: Record<string, unknown> }): string | null {
  const raw = request.headers['x-organization-id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// Helper: calculate usage cost (Plan 3e Task 16)
// ---------------------------------------------------------------------------

function calculateUsageCost(promptTokens: number, completionTokens: number): number {
  // Approximate cost based on Haiku (cheapest) pricing
  // Real deployment would query stored cost or use model-specific pricing
  // Haiku: $0.80/$4 per 1M, but default to conservative mid-range estimate
  const promptPricePerMillion = 3.0;
  const completionPricePerMillion = 15.0;
  const promptCost = (promptTokens / 1_000_000) * promptPricePerMillion;
  const completionCost = (completionTokens / 1_000_000) * completionPricePerMillion;
  return parseFloat((promptCost + completionCost).toFixed(6));
}

// ---------------------------------------------------------------------------
// MCP wrapper + repoSync for the rewind route.
//
// Mirrors defaultMcp()/getDefaultDeps() in loop.ts (not exported from there),
// but shares the SAME cache instance via getSharedWorkingTreeCache() so a
// rewind's pullSnapshot()/pushCurrentTree() operate on the same in-memory
// working tree that runAgentTurn reads/writes.
//
// Built lazily (not at module scope) so unit tests that vi.mock loop.js with
// a partial mock (only runAgentTurn) don't blow up trying to resolve
// getSharedWorkingTreeCache() at import time.
// ---------------------------------------------------------------------------

const rewindMcp = {
  async call(name: string, args: unknown, jwt: string) {
    const r = await callMcpTool(name, args, jwt);
    if (!r.ok) throw new Error(r.error ?? 'mcp call failed');
    return r.result;
  },
};

function getRewindRepoSync() {
  return createRepoSync({ cache: getSharedWorkingTreeCache(), mcp: rewindMcp });
}

// ---------------------------------------------------------------------------
// Office Ask executors (skill_creator + org integration reads)
// ---------------------------------------------------------------------------

export type OfficeAskExecutors = {
  skillCreator?: SkillCreatorExecutor;
  integrationReader?: IntegrationReader;
};

type OfficeAskLoader = (input: {
  controlPool: unknown;
  conversation: { origin: string; organizationId: string | null };
  userId: string;
}) => Promise<OfficeAskExecutors>;

let officeAskLoader: OfficeAskLoader | null = null;

/** Test-only: replace the overlay import. Pass `null` to restore. */
export function __setOfficeAskExecutorsLoaderForTest(loader: OfficeAskLoader | null): void {
  officeAskLoader = loader;
}

/**
 * The overlay supplies these ONLY for an owner's Office Ask turn; it performs
 * the role check. This function performs the provenance gate (Office only) and
 * FAILS CLOSED to `{}` whenever the overlay is absent or throws — OSS mode has
 * no skill store and no organization integrations, so neither tool may exist
 * there.
 */
export async function resolveOfficeAskExecutors(
  input: Parameters<OfficeAskLoader>[0],
): Promise<OfficeAskExecutors> {
  if (input.conversation.origin !== 'office') return {};
  if (officeAskLoader) {
    try { return await officeAskLoader(input); } catch { return {}; }
  }
  try {
    // @ts-expect-error — overlay path exists only in the built cloud image
    const overlay = await import('../../../../cloud-overlays/dist/cloud-overlays/office/skills/tool-executor.js');
    return await overlay.officeAskExecutors(input) as OfficeAskExecutors;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Snapshot list + label merge (used by GET /conversations/:id/snapshots).
//
// Exported standalone so it can be unit-tested without booting Fastify or
// mocking the MCP client — see dashboard-agent.e2e.test.ts.
// ---------------------------------------------------------------------------

export type RawSnapshot = {
  snapshot_id?: string;
  snapshotId?: string;
  message?: string | null;
  files_count?: number | null;
  filesCount?: number | null;
  created_at?: string;
  createdAt?: string;
};

export type MergedSnapshot = {
  id: string;
  message: string | null;
  files_count: number | null;
  created_at: string;
  label: string | null;
  auto_generated_label: boolean;
};

export function mergeSnapshotsWithLabels(
  rawSnapshots: RawSnapshot[],
  labels: SnapshotLabel[]
): MergedSnapshot[] {
  const labelBySnapshotId = new Map(labels.map((l) => [l.snapshotId, l]));

  const merged = rawSnapshots.map((s) => {
    const id = s.snapshot_id ?? s.snapshotId ?? '';
    const label = labelBySnapshotId.get(id) ?? null;
    return {
      id,
      message: s.message ?? null,
      files_count: s.files_count ?? s.filesCount ?? null,
      created_at: s.created_at ?? s.createdAt ?? '',
      label: label ? label.label : null,
      auto_generated_label: label ? label.autoGenerated : false,
    };
  });

  // Sort newest-first.
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

  return merged;
}

/**
 * The assistant's default model and the resolver that honours a user's pick.
 * Lives in its own module so it is unit-testable without standing up the
 * route's fastify/pg dependencies — see services/dashboard-agent/assistant-model.ts
 * for why this id is the default and what the picker can and cannot filter.
 */
export { DEFAULT_ASSISTANT_MODEL, resolveAssistantModel } from '../services/dashboard-agent/assistant-model.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createConversationBody = z.object({
  title: z.string().min(1).max(500).default('New conversation'),
  // Optional — falls back to DEFAULT_ASSISTANT_MODEL when the caller sends none.
  model: z.string().min(1).default(DEFAULT_ASSISTANT_MODEL),
  /**
   * Task 9 — a client may ASK for an Office conversation; it cannot choose the
   * organization. The org comes from the membership-checked
   * `x-organization-id` header and is bound immutably by the server. Zod
   * strips any `organization_id` a body carries, which is the point: no
   * request field can bind a conversation to an org the caller did not prove
   * membership of.
   */
  origin: z.enum(['dashboard', 'office']).optional(),
});

/**
 * Can this conversation be used from the organization the request names?
 *
 * Ordinary dashboard conversations predate provenance (and have none): they
 * stay reachable exactly as they always were, by their owner. An Office
 * conversation is bound for life to one organization — a member of two orgs
 * who opens it with the other one selected gets the same 404 as a stranger,
 * so neither its existence nor its content leaks across the boundary.
 *
 * Comparison is case-insensitive because Postgres normalises a UUID's casing
 * in storage while the header is whatever the client sent.
 */
export function isConversationReachableFromOrg(
  conversation: { origin: string; organizationId: string | null },
  requestOrgId: string | null,
): boolean {
  if (conversation.origin !== 'office') return true;
  if (!conversation.organizationId || !requestOrgId) return false;
  return conversation.organizationId.toLowerCase() === requestOrgId.toLowerCase();
}

/**
 * Load a conversation for a request and enforce its organization binding in
 * one step. Every conversation-scoped route uses this instead of a bare
 * `getConversation`, so a future route cannot forget the check: the only way
 * to get a row back from here is to be its owner AND to name its organization.
 */
async function getConversationForRequest(
  pool: pg.Pool,
  id: string,
  userId: string,
  request: { headers: Record<string, unknown> },
) {
  const conversation = await getConversation(pool, id, userId);
  if (!conversation) return null;
  if (!isConversationReachableFromOrg(conversation, readOrgId(request))) return null;
  return conversation;
}

/**
 * Task 9 — the pre-stream eligibility check for an Office-origin turn.
 *
 * The loop rechecks this before every model request and every tool batch, so
 * this is not the control; it exists because the loop's own refusal lands
 * AFTER the SSE hijack, where the only channel left is an event. A customer
 * whose subscription lapsed should get an honest 403 on the Ask request, not
 * a stream that opens and then says nothing useful.
 *
 * Runs before any spend and before headers. Ordinary dashboard conversations
 * are not consulted — the policy is an Office product gate, and the dashboard
 * remains its own surface.
 */
async function officeTurnAccessOutcome(
  conversation: { origin: string; organizationId: string | null },
  userId: string,
  model: string,
): Promise<{ ok: true } | { ok: false; code: 403; error: string }> {
  if (conversation.origin !== 'office' || !conversation.organizationId) return { ok: true };

  const access = await evaluateOperatorAccess({
    organizationId: conversation.organizationId,
    phase: 'run',
    origin: 'office',
    actorUserId: userId,
    model,
  });
  if (!access.allowed) {
    return { ok: false, code: 403, error: access.reason ?? 'service_unavailable' };
  }
  return { ok: true };
}

const postMessageBody = z.object({
  conversation_id: z.string().uuid(),
  message: z.string().min(1),
  // Optional — falls back to DEFAULT_ASSISTANT_MODEL when the caller sends none.
  model: z.string().min(1).default(DEFAULT_ASSISTANT_MODEL),
});

const rewindBody = z.object({
  app_id: z.string().min(1),
  snapshot_id: z.string().min(1),
});

const labelSnapshotBody = z.object({
  app_id: z.string().min(1),
  snapshot_id: z.string().min(1),
  label: z.string().min(1).max(200),
});

const resolveApprovalBody = z
  .object({
    status: z.enum(['approved', 'denied']),
    trust_scope: z.enum(['conversation']).optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();

const renameConversationBody = z.object({
  title: z.string().trim().min(1).max(200),
});

const pinConversationBody = z.object({
  pinned: z.boolean(),
});

const regenerateBody = z.object({
  message_id: z.string().uuid(),
  new_user_message: z.string().min(1).optional(),
});

// rating: 1 (thumbs up) | -1 (thumbs down) | 0 (un-rate — clears both
// rating + rating_reason). `reason` is only meaningful alongside rating: -1;
// the store silently drops it otherwise (documented in rateMessage's jsdoc).
const rateMessageBody = z.object({
  rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
  reason: z.string().max(2000).optional(),
});

// ---------------------------------------------------------------------------
// Operator approvals (org-scoped)
// ---------------------------------------------------------------------------

export type OperatorOrgOutcome =
  | { ok: true; orgId: string }
  | { ok: false; code: 400 | 403; error: string };

/**
 * Resolve the org an operator-approval request is scoped to, and prove the
 * caller belongs to it.
 *
 * `x-organization-id` is a plain client-supplied header — `readOrgId` above
 * does NOT authorise anything, it only reads. Everywhere else in this file the
 * header is used as a *hint* that narrows an already user-scoped query
 * (`getConversation(pool, id, userId)`), so a forged value can only ever
 * narrow the caller's own data. The operator routes have no such user filter:
 * the operator conversation's `user_id` is the sentinel `operator:<org>`, so
 * the org id IS the entire authorisation boundary. Trusting the raw header
 * here would let any logged-in user list and resolve any other org's pending
 * approvals — and execute their gated tools — by changing one header.
 *
 * So this checks `organization_members` directly. The auth plugin performs the
 * same check when populating `request.auth.organizationId`, but it silently
 * nulls a non-member header rather than rejecting, which would surface here as
 * an indistinguishable "no org supplied". An explicit check gives a truthful
 * 403 and does not depend on the auth plugin's fallback behaviour.
 */
export async function resolveCallerOrgId(
  pool: pg.Pool,
  request: { headers: Record<string, unknown> },
  userId: string,
): Promise<OperatorOrgOutcome> {
  const headerOrgId = readOrgId(request);
  if (!headerOrgId) return { ok: false, code: 400, error: 'x-organization-id required' };

  // organization_members.organization_id is `uuid`; comparing a non-uuid string
  // against it makes Postgres raise 22P02 and the route 500s on a value the
  // client fully controls. Reject the shape before it reaches the database.
  if (!z.string().uuid().safeParse(headerOrgId).success) {
    return { ok: false, code: 400, error: 'x-organization-id must be a uuid' };
  }

  // Return the org id the DATABASE holds, not the header string. Both columns
  // here are `uuid`, so Postgres normalises a non-canonical header (uppercase,
  // braces) and the membership check passes — but the value then flows into a
  // comparison against dashboard_agent_conversations.organization_id, which is
  // TEXT and matched exactly. Echoing the header back would give a legitimate
  // member a silent 404 on every approval.
  const member = await pool.query<{ organization_id: string }>(
    `SELECT organization_id::text AS organization_id FROM organization_members
     WHERE organization_id = $1 AND user_id = $2 LIMIT 1`,
    [headerOrgId, userId],
  );
  if ((member.rowCount ?? 0) === 0) {
    return { ok: false, code: 403, error: 'not a member of the requested organization' };
  }

  return { ok: true, orgId: member.rows[0].organization_id };
}

/** Authorized projection; frozen executable arguments remain server-only. */
async function projectOrgApproval(pool: pg.Pool, approval: OrgApproval, orgId: string, userId: string, authMethod?: string) {
  const [owner, access, cached] = await Promise.all([
    isOrganizationOwner(pool, orgId, userId),
    evaluateOperatorAccess({ organizationId: orgId, actorUserId: userId, origin: approval.source, phase: 'execute' }),
    approval.proposalDetails ? readConfirmedExecution(pool, approval) : Promise.resolve(null),
  ]);
  const current = cached ? { ...approval, executionOutcome: {
    version: 1 as const, state: 'succeeded' as const, attemptCount: Math.max(1, approval.executionOutcome?.attemptCount ?? 0),
    startedAt: approval.executionOutcome?.startedAt ?? null, finishedAt: approval.executionOutcome?.finishedAt ?? approval.resolvedAt ?? null,
    safeErrorCode: null, resultReference: { kind: 'tool_execution' as const, id: approval.id },
  } } : approval;
  const review = await buildProposalReview(current, {
    organizationId: orgId, actorUserId: userId, origin: approval.source,
    conversationId: approval.conversationId,
    operation: approval.approvedOperation ?? { version: 1, toolName: approval.toolName, args: approval.toolArgs },
    validateRegisteredToolArguments: validateProposalToolArguments,
  }, { approve: owner && access.allowed && (authMethod === undefined || authMethod === 'jwt'), decline: true, requestReview: owner && (authMethod === undefined || authMethod === 'jwt') });
  return {
    id: approval.id, conversationId: approval.conversationId, turnMessageId: approval.turnMessageId,
    toolName: approval.toolName, toolArgs: redactProposalArguments(approval.toolArgs), sensitivity: approval.sensitivity,
    status: approval.status, trustScope: approval.trustScope, denyReason: approval.denyReason,
    createdAt: approval.createdAt, resolvedAt: approval.resolvedAt, resolvedBy: approval.resolvedBy,
    source: approval.source, references: [], review,
    tool_name: approval.toolName, created_at: approval.createdAt, resolved_at: approval.resolvedAt,
  };
}

export type OperatorResolveOutcome =
  | { ok: true }
  | { ok: false; code: 400 | 403 | 404 | 409 | 502; error: string };

/**
 * Is `userId` a current OWNER of `orgId`?
 *
 * The operator routes authorise on membership (any member may see and, for an
 * ordinary self-hosted operator, resolve). Task 8 tightens that for
 * CONSEQUENTIAL Office approvals: only an owner may approve a deployment or a
 * live-data change. Read from the database on every resolution — an
 * indefinitely cached role is exactly the stale authority the spec forbids.
 */
export async function isOrganizationOwner(
  pool: pg.Pool,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const result = await pool.query<{ role: string }>(
    `SELECT role FROM organization_members
      WHERE organization_id = $1 AND user_id = $2 LIMIT 1`,
    [orgId, userId],
  );
  return result.rows[0]?.role === 'owner';
}

/**
 * Org-scoped approval resolution for operator turns.
 *
 * Execution goes through executeApprovedOperatorTool, which wraps executeOnce
 * so an approve that is retried — by a double-click, a proxy retry, or a warm
 * resume in Plan 2 — cannot fire the tool twice, and additionally bridges a
 * gated `manage_substrate` propose to substrate's own approve(action_id) so
 * one human click executes the capability rather than parking a second
 * approval inside substrate (see substrate-approval-bridge.ts).
 *
 * Everything after execution is delegated to resume.ts's
 * `completeApprovalResolution`, NOT reimplemented here. That is the whole fix
 * for C2. The earlier version of this function resolved the approval row and
 * stopped, on the assumption that "the operator's loop picks the resolution
 * up". It does not, and cannot: the loop persisted an assistant row carrying a
 * `tool_call_id` with no matching tool result, and the AI gateway rejects any
 * history that ends that way. With exactly one operator conversation per org,
 * reused forever, the FIRST resolved gate — approve or deny — left that org's
 * operator sending an invalid message sequence on every wake, every ten
 * minutes, permanently, recoverable only by hand-editing the database.
 *
 * The deny path must write the tool row too. Denial is not "nothing happened";
 * it is a tool result the model has to see, and it was the path that reached
 * the wedge first.
 *
 * `principal: 'human'` is correct here and is not a formality: a person
 * clicked approve in the operator feed, so the manage_substrate action
 * denials — which exist to stop the AGENT approving its own proposals — do not
 * apply to this call. The tool-level allowlist still does.
 *
 * Callers MUST have already established that `input.orgId` is an org the
 * caller belongs to (see resolveCallerOrgId). This function does not authorise.
 */
export async function resolveOperatorApproval(
  pool: pg.Pool,
  input: {
    approvalId: string;
    orgId: string;
    jwt: string;
    /**
     * The org member resolving this approval — sourced from the route's own
     * `requireUserId(request)`, not a new parameter threaded in for this
     * purpose. Recorded on the approval row (resolved_by) so it is auditable
     * which human authorised an operator-raised, irreversible action.
     */
    userId: string;
    /**
     * How the caller authenticated (`request.auth.authMethod`). Only a human
     * session may approve a consequential Office action — service keys and
     * API keys cannot. Optional because direct/server callers (tests, internal
     * helpers) have no transport to read it from; the HTTP route always
     * supplies it.
     */
    authMethod?: string;
    /** Server-only admission adapter; HTTP bodies cannot supply executors. */
    executeApproval?: ApprovalExecutor;
    resolution: { status: 'approved' } | { status: 'denied'; reason?: string };
  },
): Promise<OperatorResolveOutcome> {
  const approval = await getApprovalForOrg(pool, input.approvalId, input.orgId);
  if (!approval) return { ok: false, code: 404, error: 'approval not found' };

  /**
   * ── Office consequential gate (Task 8) ──────────────────────────────────
   *
   * In cloud mode the access policy answers `approvalMode: 'consequential'`
   * for operator/Office origins. A consequential approval is:
   *
   *   - approvable only by a HUMAN session (not a service/API key);
   *   - approvable only by a CURRENT OWNER of the approval's organization;
   *   - executable only while the policy still allows `execute` for that org
   *     (paid entitlement, account state, managed credential, funding);
   *   - required to carry a recorded immutable operation. A legacy row that
   *     predates one must be re-proposed rather than executed on trust.
   *
   * DENIAL IS DELIBERATELY NOT GATED. Refusing old work must remain possible
   * with no paid plan, no credits and no current owner — that is how an org
   * unwinds a pending action. The evaluation therefore runs only for approve,
   * and the deny path is unchanged.
   */
  const access =
    input.resolution.status === 'approved'
      ? await evaluateOperatorAccess({
          organizationId: input.orgId,
          phase: 'execute',
          /**
           * The row's own surface decides the origin. An Office-origin
           * foreground approval (Task 9) is listed here beside the operator's
           * and must be judged by the same Office contract; passing
           * 'operator' for it would be a lie the policy currently happens to
           * treat identically, which is exactly the kind of coincidence that
           * breaks silently when the policy changes.
           */
          origin: approval.source === 'office' ? 'office' : 'operator',
          actorUserId: input.userId,
        })
      : { allowed: true, reason: null, approvalMode: 'standard' as const };
  const officeConsequential = access.approvalMode === 'consequential';

  if (input.resolution.status === 'approved' && officeConsequential) {
    if (input.authMethod !== undefined && input.authMethod !== 'jwt') {
      return {
        ok: false,
        code: 403,
        error: 'a human organization-owner session is required to approve this action',
      };
    }
    if (!(await isOrganizationOwner(pool, input.orgId, input.userId))) {
      return { ok: false, code: 403, error: 'only an organization owner may approve this action' };
    }
    if (!access.allowed) {
      // 409: the approval is still valid and still pending; it simply cannot
      // execute under the organization's current state. Denial remains
      // available, so this is not a wedge.
      return { ok: false, code: 409, error: access.reason ?? 'service_unavailable' };
    }
    if (!approval.approvedOperation) {
      return {
        ok: false,
        code: 409,
        error: 'approval_operation_missing: this approval must be re-proposed',
      };
    }
  }

  const outcome = await completeApprovalResolution(pool, {
    approval,
    resolution: input.resolution,
    resolvedBy: input.userId,
    // Exactly-once: the advisory-lock transaction in executeOnce, plus its
    // success cache keyed on approval_id. Because a repeated execution is
    // served from that cache, a retry after a partway failure re-drives this
    // whole path safely rather than firing the tool a second time.
    //
    // executeApprovedOperatorTool wraps executeOnce (it does not replace it,
    // and does not weaken the lock) to add the substrate approval bridge:
    // a gated `manage_substrate` propose is followed by substrate's NATIVE
    // approve(action_id), so the human's one click actually EXECUTES the
    // capability instead of leaving a second pending action for them to
    // approve again. See substrate-approval-bridge.ts.
    execute: async (a, resolutionPool) => {
      if (input.executeApproval) {
        // A transport-specific executor replaces dispatch, never the prepared
        // review boundary. Check the locked, current row before lending it out.
        if (officeConsequential || a.proposalDetails) {
          if (!a.proposalDetails || !a.approvedOperation) return { ok: false, code: 'proposal_review_required', error: 'Request a complete proposal before approving this legacy action.' };
          const currentAccess = await evaluateOperatorAccess({ organizationId: input.orgId, actorUserId: input.userId,
            origin: approval.source, phase: 'execute' });
          if (!currentAccess.allowed || !(await isOrganizationOwner(resolutionPool ?? pool, input.orgId, input.userId))) {
            return { ok: false, code: 'office_access_blocked', error: 'Current owner access is required.' };
          }
          const verification = await verifyPreparedApproval({ organizationId: input.orgId, actorUserId: input.userId,
            origin: approval.source, conversationId: a.conversationId, operation: a.approvedOperation,
            validateRegisteredToolArguments: validateProposalToolArguments }, a);
          if (verification.status !== 'valid') return { ok: false, code: verification.code, error: verification.code };
        }
        return input.executeApproval(a, resolutionPool);
      }
      return executeApprovedOperatorTool(resolutionPool ?? pool, {
        approvalId: a.id,
        name: a.toolName,
        args: a.toolArgs,
        jwt: input.jwt,
        orgId: input.orgId,
        // `a.traceId`, not a value derived here: the resolving human's
        // request carries no trace of its own, and the whole point is that
        // this execution reports the id of the TURN that gated, not a fresh
        // one for the click that resolved it.
        traceId: a.traceId,
        // The row carries the immutable operation and the conversation whose
        // working tree a deploy replay needs. A deploy approved here runs
        // through the same HTTP transports a live turn uses; a changed tree
        // is refused with approval_operation_changed.
        approval: a,
        officeConsequential,
        actorUserId: input.userId,
        origin: approval.source === 'office' ? 'office' : 'operator',
        cache: getSharedWorkingTreeCache(),
        // The snapshot, not the process cache, is what proves and builds a
        // deploy on whichever API machine resolves this approval.
        treeStore: getSharedDeployTreeStore(),
      });
    },
    /**
     * Deny path, SUBSTRATE-ESCALATED approvals only (fix E).
     *
     * Those are raised after the propose already dispatched, so a real action
     * sits in substrate's ledger in `proposed`. Denying at our layer alone
     * would leave it there indefinitely — the same invisible stall this fix
     * exists to remove, one step later. `rejectEscalatedSubstrateAction` is a
     * no-op (attempted: false) for every other approval kind, because those
     * paused before dispatch and there is nothing on the far side.
     */
    denyCleanup: (a, resolutionPool) =>
      rejectEscalatedSubstrateAction(resolutionPool ?? pool, {
        approvalId: a.id,
        approval: { toolName: a.toolName, toolArgs: a.toolArgs },
        reason: input.resolution.status === 'denied' ? input.resolution.reason : undefined,
        jwt: input.jwt,
        orgId: input.orgId,
      }),
  });

  if (!outcome.ok) return { ok: false, code: outcome.code, error: outcome.error };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function dashboardAgentRoutes(app: FastifyInstance) {
  // ── Startup env warnings ─────────────────────────────────────────────────
  if (process.env.DASHBOARD_ASSISTANT_ENABLED === '1') {
    if (!process.env.AI_GATEWAY_URL) {
      app.log.warn('DASHBOARD_ASSISTANT_ENABLED=1 but AI_GATEWAY_URL is unset; dashboard-agent chat turns will fail at runtime (defaulting to http://localhost:3000).');
    }
    if (!process.env.MCP_SERVER_URL) {
      app.log.warn('DASHBOARD_ASSISTANT_ENABLED=1 but MCP_SERVER_URL is unset; dashboard-agent tool calls will fail at runtime (defaulting to http://localhost:3010).');
    }
  }

  // ── POST /conversations ──────────────────────────────────────────────────
  app.post('/conversations', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);

    const parsed = createConversationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const model = resolveAssistantModel(parsed.data.model);

    /**
     * ── Office creation (Task 9) ──────────────────────────────────────────
     *
     * Asking for an Office conversation is the only way one comes into
     * existence, and the server decides both facts that make it an Office:
     *
     *   - the ORGANIZATION is the membership-checked `x-organization-id`
     *     header (resolveCallerOrgId proves membership and returns the
     *     database's own normalisation of it);
     *   - eligibility is the registered access policy's `run` answer for that
     *     organization with the asking human as the audit identity — a paid
     *     plan, an enabled activation, a current managed credential, and
     *     funding. A member may create; the policy does not require them to be
     *     the owner.
     *
     * A denial writes nothing. The client cannot supply an organization id: it
     * is stripped by the schema, so the only org it can bind is one it just
     * proved membership of.
     */
    const wantsOffice = parsed.data.origin === 'office';

    if (wantsOffice) {
      const org = await resolveCallerOrgId(app.controlDb, request, userId);
      if (!org.ok) return reply.code(org.code).send({ error: org.error });

      const access = await evaluateOperatorAccess({
        organizationId: org.orgId,
        phase: 'run',
        origin: 'office',
        actorUserId: userId,
        model,
      });
      if (!access.allowed) {
        return reply.code(403).send({ error: access.reason ?? 'office_not_available' });
      }

      const conversation = await createConversation(app.controlDb, userId, parsed.data.title, model, {
        origin: 'office',
        organizationId: org.orgId,
      });
      return reply.code(201).send({ conversation });
    }

    const conversation = await createConversation(
      app.controlDb,
      userId,
      parsed.data.title,
      model,
    );

    return reply.code(201).send({ conversation });
  });

  // ── GET /conversations ───────────────────────────────────────────────────
  app.get('/conversations', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);

    const conversations = await listConversations(app.controlDb, userId);
    return reply.send({ conversations });
  });

  // ── GET /conversations/:id ───────────────────────────────────────────────
  app.get('/conversations/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const messages = await listMessages(app.controlDb, id);
    return reply.send({ conversation, messages });
  });

  // ── DELETE /conversations/:id ────────────────────────────────────────────
  app.delete('/conversations/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    if (await isOfficeClientConversation(app.controlDb, id)) return reply.code(409).send({ error: 'Continue this conversation through an Office client.', code: 'office_client_conversation_required' });
    await deleteConversation(app.controlDb, id, userId);
    return reply.code(204).send();
  });

  // ── PATCH /conversations/:id — update model (persists picker choice) ────
  const patchConversationBody = z.object({
    model: z.string().min(1).max(200),
  });
  app.patch('/conversations/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const body = patchConversationBody.parse(request.body);

    // Persists the picker choice so regenerate/resume replay on the same model.
    const updated = await updateConversationModel(app.controlDb, id, userId, resolveAssistantModel(body.model));
    if (!updated) return reply.code(404).send({ error: 'conversation not found' });
    return reply.send({ conversation: updated });
  });

  // ── PATCH /conversations/:id/rename — user-chosen title ─────────────────
  app.patch('/conversations/:id/rename', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = renameConversationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const updated = await renameConversation(app.controlDb, id, userId, parsed.data.title);
    if (!updated) return reply.code(404).send({ error: 'conversation not found' });
    return reply.send({ conversation: updated });
  });

  // ── POST /conversations/:id/duplicate — copy conversation + messages ────
  app.post('/conversations/:id/duplicate', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    // Ownership check up front so a bad id 404s without touching the store's
    // transaction (duplicateConversation throws for the same case, but this
    // gives an early, cheap, consistent 404 path with the rest of the file).
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const duplicate = await duplicateConversation(app.controlDb, id, userId);
    return reply.code(201).send({ conversation: duplicate });
  });

  // ── POST /conversations/:id/pin — set/clear pinned_at ────────────────────
  app.post('/conversations/:id/pin', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = pinConversationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const updated = await pinConversation(app.controlDb, id, userId, parsed.data.pinned);
    if (!updated) return reply.code(404).send({ error: 'conversation not found' });
    return reply.send({ conversation: updated });
  });

  // ── POST /messages (SSE agent turn) ─────────────────────────────────────
  app.post('/messages', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);

    const parsed = postMessageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { conversation_id, message, model } = parsed.data;

    // Ownership check BEFORE sending SSE headers — once headers are sent we
    // cannot return a JSON 404.
    const conversation = await getConversationForRequest(app.controlDb, conversation_id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    if (conversation.origin === 'office' && await isOfficeClientConversation(app.controlDb, conversation.id)) return reply.code(409).send({ error: 'Continue this conversation through an Office client.', code: 'office_client_conversation_required' });

    /**
     * Eligibility, also before headers. The loop rechecks it per request, but
     * a lost entitlement should not open a stream first.
     */
    const officeAccess = await officeTurnAccessOutcome(
      conversation,
      userId,
      resolveAssistantModel(model),
    );
    if (!officeAccess.ok) {
      return reply.code(officeAccess.code).send({ error: officeAccess.error });
    }

    /**
     * Office Ask tools, resolved BEFORE the stream opens: an owner's Office
     * conversation may receive the skill creator and the org integration
     * reader; a member's and every dashboard conversation get `{}`.
     */
    const officeAsk = await resolveOfficeAskExecutors({
      controlPool: app.controlDb,
      conversation,
      userId,
    });

    // Extract JWT verbatim from Authorization header for the loop / gateway.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Begin SSE response. reply.hijack() bypasses Fastify's onSend, which is where
    // @fastify/cors normally injects Access-Control-Allow-Origin. Reflect the caller
    // origin explicitly so browsers accept the stream.
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      reply.raw.setHeader('access-control-allow-origin', requestOrigin);
      reply.raw.setHeader('vary', 'origin');
      reply.raw.setHeader('access-control-allow-credentials', 'true');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    // Best-effort disconnect tracking (MVP: log; generator drains naturally)
    let clientDisconnected = false;
    request.raw.on('close', () => {
      clientDisconnected = true;
      app.log.debug({ conversationId: conversation_id }, 'dashboard-agent SSE client disconnected');
    });

    try {
      const gen = runAgentTurn({
        conversationId: conversation_id,
        userId,
        jwt,
        userMessage: message,
        // Resolve rather than passing the parsed value straight through: the
        // zod default only fires when `model` is absent, so an explicit empty
        // or whitespace id would otherwise reach the gateway verbatim.
        model: resolveAssistantModel(model),
        pool: app.controlDb,
        organizationId: readOrgId(request),
        ...officeAsk,
      });

      for await (const event of gen) {
        publishEvent(conversation_id, event);
        if (clientDisconnected) continue;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEvent = { type: 'error' as const, message: msg };
      publishEvent(conversation_id, errEvent);
      if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // ── GET /conversations/:id/stream ────────────────────────────────────────
  // Persistent SSE — subscribes to the in-process event bus so any running
  // turn's events flow into this connection, even without holding the
  // original POST /messages open. Heartbeat every 25s keeps proxies happy.
  app.get('/conversations/:id/stream', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });
    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });

    // reply.hijack() bypasses Fastify's onSend (where @fastify/cors normally
    // injects CORS headers), so reflect the caller Origin explicitly.
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      reply.raw.setHeader('access-control-allow-origin', requestOrigin);
      reply.raw.setHeader('vary', 'origin');
      reply.raw.setHeader('access-control-allow-credentials', 'true');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.raw.setHeader('x-accel-buffering', 'no');
    reply.hijack();

    let disconnected = false;
    const unsubscribe = subscribeToConversation(id, (evt) => {
      if (disconnected) return;
      try { reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* noop */ }
    });
    const heartbeat = setInterval(() => {
      if (disconnected) return;
      try { reply.raw.write(`: ping\n\n`); } catch { /* noop */ }
    }, 25_000);
    try { reply.raw.write(`: subscribed\n\n`); } catch { /* noop */ }

    request.raw.on('close', () => {
      disconnected = true;
      clearInterval(heartbeat);
      unsubscribe();
      try { reply.raw.end(); } catch { /* noop */ }
    });
  });

  // ── POST /messages/:id/rate — thumbs up/down + optional reason (Task 19) ─
  app.post('/messages/:id/rate', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = rateMessageBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    // Ownership check via conversation_id → user_id join — 404 for both a
    // nonexistent message and a message that belongs to another user's
    // conversation (no distinction leaked to the caller).
    const message = await getMessageWithOwner(app.controlDb, id, userId);
    if (!message) {
      return reply.code(404).send({ error: 'message not found' });
    }
    if (message.role !== 'assistant') {
      return reply.code(400).send({ error: 'only assistant messages can be rated' });
    }

    await rateMessage(app.controlDb, id, parsed.data.rating, parsed.data.reason);

    const updated = await getMessageWithOwner(app.controlDb, id, userId);
    return reply.send({ message: updated });
  });

  // ── POST /conversations/:id/regenerate ───────────────────────────────────
  //
  // Two-in-one endpoint (Plan 3e Task 6):
  //   - Regenerate: {message_id} only. message_id MUST reference an
  //     'assistant' row. Deletes that row + everything after it, then
  //     replays the last remaining user message.
  //   - Edit-and-resend: {message_id, new_user_message}. message_id MUST
  //     reference a 'user' row. Deletes that row + everything after it, then
  //     runs new_user_message as the next user turn.
  // Streams the resulting turn via SSE, same wire format as /messages.
  app.post('/conversations/:id/regenerate', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = regenerateBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { message_id: messageId, new_user_message: newUserMessage } = parsed.data;

    // Ownership check BEFORE sending SSE headers — once headers are sent we
    // cannot return a JSON 404/400.
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    if (conversation.origin === 'office' && await isOfficeClientConversation(app.controlDb, conversation.id)) return reply.code(409).send({ error: 'Continue this conversation through an Office client.', code: 'office_client_conversation_required' });

    /**
     * Eligibility BEFORE the destructive part of regenerate. Losing the
     * entitlement must stop the spend — and must not delete a customer's
     * messages on the way to discovering it cannot answer.
     */
    const officeAccess = await officeTurnAccessOutcome(
      conversation,
      userId,
      resolveAssistantModel(conversation.model),
    );
    if (!officeAccess.ok) {
      return reply.code(officeAccess.code).send({ error: officeAccess.error });
    }

    const target = await getMessageById(app.controlDb, id, messageId);
    if (!target) {
      return reply.code(404).send({ error: 'message not found' });
    }

    let userMessageToReplay: string;

    if (newUserMessage != null) {
      // Edit-and-resend: message_id must be a user row.
      if (target.role !== 'user') {
        return reply.code(400).send({ error: 'new_user_message requires message_id to reference a user message' });
      }
      await deleteMessagesFromInclusive(app.controlDb, id, messageId);
      userMessageToReplay = newUserMessage;
    } else {
      // Regenerate: message_id must be an assistant row.
      if (target.role !== 'assistant') {
        return reply.code(400).send({ error: 'message_id must reference an assistant message to regenerate' });
      }
      await deleteMessagesFromInclusive(app.controlDb, id, messageId);
      const lastUser = await getLastUserMessage(app.controlDb, id);
      if (!lastUser) {
        return reply.code(400).send({ error: 'no user message to regenerate from' });
      }
      userMessageToReplay = lastUser.content;
    }

    // Extract JWT verbatim from Authorization header, same as /messages.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Begin SSE response — mirrors /messages.
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      reply.raw.setHeader('access-control-allow-origin', requestOrigin);
      reply.raw.setHeader('vary', 'origin');
      reply.raw.setHeader('access-control-allow-credentials', 'true');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    let clientDisconnected = false;
    request.raw.on('close', () => {
      clientDisconnected = true;
      app.log.debug({ conversationId: id }, 'dashboard-agent regenerate SSE client disconnected');
    });

    try {
      const gen = runAgentTurn({
        conversationId: id,
        userId,
        jwt,
        userMessage: userMessageToReplay,
        model: resolveAssistantModel(conversation.model),
        pool: app.controlDb,
        organizationId: readOrgId(request),
      });

      for await (const event of gen) {
        publishEvent(id, event);
        if (clientDisconnected) continue;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEvent = { type: 'error' as const, message: msg };
      publishEvent(id, errEvent);
      if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  // ── POST /conversations/:id/rewind ───────────────────────────────────────
  //
  // Restores the conversation's working-tree cache to an earlier snapshot's
  // state, then pushes that state back out as a brand-new snapshot (history
  // is append-only — we never delete or rewrite existing snapshots). Returns
  // a plain JSON summary rather than SSE; the frontend refetches conversation
  // state afterwards to pick up the new assistant message + latest files.
  app.post('/conversations/:id/rewind', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = rewindBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { app_id: appId, snapshot_id: snapshotId } = parsed.data;

    // 1. Ownership check.
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    if (conversation.origin === 'office' && await isOfficeClientConversation(app.controlDb, conversation.id)) return reply.code(409).send({ error: 'Continue this conversation through an Office client.', code: 'office_client_conversation_required' });

    // Extract JWT verbatim from Authorization header, same as /messages.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // 2. Loose guard: app_id must have shown up in this conversation's
    // tool_args at least once. Best-effort — if the lookup itself throws we
    // don't block the rewind on it (schema/store hiccups shouldn't brick the
    // feature), but if it succeeds and the app_id truly never appeared, reject.
    try {
      const recentAppIds = await getRecentAppIds(app.controlDb, id);
      if (recentAppIds.length > 0 && !recentAppIds.includes(appId)) {
        return reply.code(400).send({ error: 'app_id not associated with this conversation' });
      }
    } catch {
      // best-effort guard only
    }

    // 3. Validate snapshot_id is a real snapshot of this app before touching
    // the cache — avoids clobbering the working tree on a typo'd snapshot_id.
    try {
      const raw: any = await rewindMcp.call('manage_repo', { action: 'list_snapshots', app_id: appId }, jwt);
      let payload: any = raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
        const textFrame = raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (textFrame) { try { payload = JSON.parse(textFrame.text); } catch { payload = {}; } }
      }
      const snapshots: Array<{ snapshot_id?: string; snapshotId?: string }> = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.snapshots) ? payload.snapshots : [];
      const ids = snapshots.map((s) => s.snapshot_id ?? s.snapshotId).filter(Boolean);
      if (ids.length > 0 && !ids.includes(snapshotId)) {
        return reply.code(400).send({ error: 'snapshot_id not found for this app' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to list snapshots: ${msg}` });
    }

    const repoSync = getRewindRepoSync();

    // 4. Pull the target snapshot — overwrites the shared cache for (id, appId).
    let filesChanged = 0;
    try {
      const pulled = await repoSync.pullSnapshot({ convId: id, appId, snapshotId, jwt });
      if (!pulled.hydrated) {
        return reply.code(400).send({ error: 'snapshot has no files or could not be hydrated' });
      }
      filesChanged = getSharedWorkingTreeCache().list(id, appId).length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `pull_snapshot failed: ${msg}` });
    }

    // 5. Push the (now-restored) cache back out as a new, append-only snapshot.
    let newSnapshotId: string | null = null;
    try {
      const pushed = await repoSync.pushCurrentTree({ convId: id, appId, jwt });
      newSnapshotId = pushed.snapshotId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `push failed: ${msg}` });
    }

    // 6. Record the rewind as an assistant message.
    await appendMessage(app.controlDb, id, {
      role: 'assistant',
      content: `Rewound to snapshot ${snapshotId}. Working tree restored.`,
      toolCallId: null,
      toolName: null,
      toolArgs: null,
      toolResult: null,
      modelUsed: null,
    });

    return reply.send({ new_snapshot_id: newSnapshotId, files_changed: filesChanged });
  });

  // ── GET /conversations/:id/apps/:app_id/tree ─────────────────────────────
  //
  // Read-only helper: hydrates a browsable file list for an app whose repo
  // exists server-side but which the current conversation has not touched
  // (e.g. the pane's App Directory picked it). Peels the MCP envelope, fetches
  // each blob's content, returns { files: [{ path, content, sha256 }] }.
  // Ownership on the conversation is checked; app-level ACL is enforced by
  // the underlying manage_repo tool.
  app.get('/conversations/:id/apps/:app_id/tree', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });
    const userId = requireUserId(request);
    const { id, app_id: appId } = request.params as { id: string; app_id: string };

    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) return reply.code(404).send({ error: 'conversation not found' });

    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    let payload: any;
    try {
      const raw: any = await rewindMcp.call('manage_repo', { action: 'pull_latest', app_id: appId }, jwt);
      payload = raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
        const textFrame = raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (textFrame) { try { payload = JSON.parse(textFrame.text); } catch { payload = {}; } }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 vs 500: pull_latest returns "no snapshot yet" as a specific error;
      // treat any failure here as empty rather than 500 so the client can render
      // "No files" instead of surfacing an obscure MCP error.
      request.log.warn({ err: msg, appId }, 'tree hydrate: pull_latest failed');
      return reply.send({ files: [] });
    }

    const files: Array<{ path: string; sha256: string; downloadUrl?: string; download_url?: string }> = payload?.files ?? [];
    if (files.length === 0) return reply.send({ files: [] });

    const out = await Promise.all(files.map(async (f) => {
      const url = f.downloadUrl ?? f.download_url;
      if (!url) return null;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const content = await resp.text();
        return { path: f.path, sha256: f.sha256, content };
      } catch { return null; }
    }));

    return reply.send({ files: out.filter((f): f is { path: string; sha256: string; content: string } => f !== null) });
  });

  // ── GET /conversations/:id/snapshots ─────────────────────────────────────
  //
  // Lists snapshot history for an app associated with this conversation,
  // left-joined with any user/auto labels recorded for (conversation, app,
  // snapshot). Sorted newest-first; labeled entries are NOT pinned to the
  // top here — that's a client-side (Plan 3d T6) concern.
  app.get('/conversations/:id/snapshots', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };
    const q = (request.query ?? {}) as { app_id?: string };
    const appId = q.app_id;

    // 1. Ownership check.
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    // 2. Validate app_id query param.
    if (!appId) {
      return reply.code(400).send({ error: 'app_id query param is required' });
    }

    // 3. Read-only route: no per-conversation association guard. The
    // underlying MCP tool (manage_repo.list_snapshots) enforces app ownership,
    // and the pane's app-directory picker lets users browse any app in their
    // active org — a stricter conversation-scoped guard here would 404 that UX.

    // Extract JWT verbatim from Authorization header, same as /messages and /rewind.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // 4. Fetch raw snapshot list from manage_repo. MCP tools return either the
    // raw payload OR an envelope { content: [{ type: 'text', text: '<json>' }] };
    // peel that here so mergeSnapshotsWithLabels always sees an array.
    let rawSnapshots: RawSnapshot[] = [];
    try {
      const raw: any = await rewindMcp.call('manage_repo', { action: 'list_snapshots', app_id: appId }, jwt);
      let payload: any = raw;
      if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
        const textFrame = raw.content.find((c: any) => c?.type === 'text' && typeof c.text === 'string');
        if (textFrame) {
          try { payload = JSON.parse(textFrame.text); } catch { payload = {}; }
        }
      }
      const listSnapshots = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.snapshots) ? payload.snapshots : [];
      rawSnapshots = listSnapshots as RawSnapshot[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `failed to list snapshots: ${msg}` });
    }

    // 5. Left-join with dashboard_agent_snapshot_labels for this (conv, app).
    const labels = await listSnapshotLabels(app.controlDb, id, appId);

    // 6. Merge + sort newest-first.
    const snapshots = mergeSnapshotsWithLabels(rawSnapshots, labels);

    return reply.send({ snapshots });
  });

  // ── POST /conversations/:id/snapshots/label ──────────────────────────────
  //
  // Records/overwrites a user-supplied label for a (conversation, app,
  // snapshot) triple. Same ownership + loose app_id-association guards as
  // the other snapshot routes.
  app.post('/conversations/:id/snapshots/label', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    const parsed = labelSnapshotBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { app_id: appId, snapshot_id: snapshotId, label } = parsed.data;

    // 1. Ownership check.
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    // 2. Loose guard: app_id must have shown up in this conversation's
    // tool_args at least once (same best-effort pattern as rewind/snapshots).
    try {
      const recentAppIds = await getRecentAppIds(app.controlDb, id);
      if (recentAppIds.length > 0 && !recentAppIds.includes(appId)) {
        return reply.code(404).send({ error: 'app_id not associated with this conversation' });
      }
    } catch {
      // best-effort guard only
    }

    await upsertSnapshotLabel(app.controlDb, {
      conversationId: id,
      appId,
      snapshotId,
      label,
      autoGenerated: false,
    });

    return reply.send({ ok: true });
  });

  // ── GET /conversations/:id/usage-total ───────────────────────────────────
  // Sum all tokens and compute total cost for a conversation (Plan 3e Task 16)
  app.get('/conversations/:id/usage-total', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id } = request.params as { id: string };

    // Ownership check
    const conversation = await getConversationForRequest(app.controlDb, id, userId, request);
    if (!conversation) {
      return reply.code(404).send({ error: 'conversation not found' });
    }

    const { promptTokens, completionTokens } = await getConversationUsageTotal(
      app.controlDb,
      id,
    );

    // Calculate cost using the helper from ai-usage-logger
    // For now use a simplified approach: average cost across common models
    // Real: fetch stored cost if available, else compute from tokens
    const totalCostUsd = calculateUsageCost(promptTokens, completionTokens);

    return reply.send({
      total_cost_usd: totalCostUsd,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
  });

  // ── GET /usage ────────────────────────────────────────
  app.get('/usage', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const q = (request.query ?? {}) as { user_id?: string; conversation_id?: string };

    // V1: users only see their own rows (no admin gate yet).
    const filterUserId = q.user_id ?? userId;
    if (filterUserId !== userId) return reply.code(403).send({ error: 'forbidden' });

    const rows = await listUsage(app.controlDb, {
      userId: filterUserId,
      conversationId: q.conversation_id,
    });

    return reply.send({ rows });
  });

  // ── GET /operator/approvals ──────────────────────────────────────────────
  //
  // Pending approvals raised by the headless operator for the caller's org.
  // Scoped by org, not by user: the operator conversation's user_id is the
  // sentinel `operator:<org>`, so no user-scoped query can ever see these.
  // Membership in that org is what authorises the read.
  app.get('/operator/approvals', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const org = await resolveCallerOrgId(app.controlDb, request, userId);
    if (!org.ok) return reply.code(org.code).send({ error: org.error });

    const approvals = await listPendingByOrg(app.controlDb, org.orgId);
    const includeHistory = (request.query as { history?: string })?.history === '1';
    const project = (approval: OrgApproval) => projectOrgApproval(app.controlDb, approval, org.orgId, userId, request.auth?.authMethod);
    const [pending, history] = await Promise.all([
      Promise.all(approvals.map(project)),
      includeHistory ? listRecentResolvedByOrg(app.controlDb, org.orgId).then(rows => Promise.all(rows.map(project))) : Promise.resolve(undefined),
    ]);
    return reply.send({ approvals: pending, ...(history ? { history } : {}) });
  });

  // ── GET /operator/approvals/:id ──────────────────────────────────────────
  //
  // ONE approval, including a resolved one. The list above is pending-only by
  // design, so a smoke or ops check could never observe the outcome it just
  // approved — the gap that made the Office canary verify resolutions by hand
  // in the database.
  //
  // Scoped exactly like the list route: membership of the organization that
  // owns the approval's conversation is what authorises the read, and the
  // lookup (`getApprovalForOrg`) applies the operator/Office-origin predicate.
  // The response is a PROJECTION — id, status, timestamps, source and tool
  // name only. No tool arguments, recorded operation, or transcript: observing
  // a decision must not become a way to read one organization's conversation.
  app.get('/operator/approvals/:id', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const org = await resolveCallerOrgId(app.controlDb, request, userId);
    if (!org.ok) return reply.code(org.code).send({ error: org.error });

    const { id } = request.params as { id: string };
    const approval = await getApprovalForOrg(app.controlDb, id, org.orgId);
    if (!approval) return reply.code(404).send({ error: 'approval not found' });

    return reply.send({ approval: await projectOrgApproval(app.controlDb, approval, org.orgId, userId, request.auth?.authMethod) });
  });

  // ── GET /operator/approvals/:id/conversation ─────────────────────────────
  //
  // The prose window that led to a decision. Membership of the approval's
  // organization authorises the read; the response carries only user/assistant
  // text up to the approval's turn. Tool rows, args and results never leave the
  // server, and the window is capped because the operator conversation is one
  // per organization forever.
  app.get('/operator/approvals/:id/conversation', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const org = await resolveCallerOrgId(app.controlDb, request, userId);
    if (!org.ok) return reply.code(org.code).send({ error: org.error });

    const rawLimit = (request.query as { limit?: string } | undefined)?.limit;
    const limit = rawLimit === undefined
      ? 20
      : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
    if (!Number.isFinite(limit) || limit < 1 || limit > 50) {
      return reply.code(400).send({ error: 'limit must be an integer between 1 and 50' });
    }

    const { id } = request.params as { id: string };
    const approval = await getApprovalForOrg(app.controlDb, id, org.orgId);
    if (!approval) return reply.code(404).send({ error: 'approval not found' });

    const window = await listApprovalConversation(app.controlDb, {
      conversationId: approval.conversationId,
      turnMessageId: approval.turnMessageId,
      approvalCreatedAt: new Date(approval.createdAt),
      limit,
    });
    return reply.send(window);
  });

  // ── GET /operator/traces ─────────────────────────────────────────────────
  //
  // TEMPORARY (2026-08-07). Read-only view of what the operator actually did,
  // turn by turn, for the dev-mode trace viewer in the dashboard. Delete this
  // route with operator-traces.ts and the dashboard's `features/operator-traces`
  // when it stops being useful.
  //
  // Scoped exactly like /operator/approvals above and for the same reason: the
  // operator conversation's user_id is the sentinel `operator:<org>`, so no
  // user-scoped query can reach it, and membership of the org is what
  // authorises the read. Do not relax this to a conversation id supplied by
  // the caller — that would turn a debugging view into a way to read any
  // org's operator transcript.
  //
  // Looks the conversation up rather than calling getOrCreateOperatorConversation:
  // a GET must not create the row, and an org whose operator has never run
  // should read as "no turns yet", not be given a conversation as a side
  // effect of someone opening a page.
  app.get('/operator/traces', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const org = await resolveCallerOrgId(app.controlDb, request, userId);
    if (!org.ok) return reply.code(org.code).send({ error: org.error });

    const q = request.query as {
      limit?: string;
      cursor?: string;
      since?: string;
      until?: string;
      order?: string;
    };
    const parsedLimit = Number.parseInt(q.limit ?? '10', 10);

    // A date that does not parse is rejected rather than ignored. Silently
    // dropping a filter shows the caller MORE than they asked for and reads as
    // if the range simply had that much in it.
    const parseDate = (raw: string | undefined, field: string) => {
      if (raw === undefined || raw === '') return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) throw new Error(`invalid ${field}: ${raw}`);
      return d;
    };

    let since: Date | null;
    let until: Date | null;
    try {
      since = parseDate(q.since, 'since');
      until = parseDate(q.until, 'until');
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : 'invalid date' });
    }
    if (since && until && since > until) {
      return reply.code(400).send({ error: 'since is after until' });
    }

    const conv = await app.controlDb.query<{ id: string }>(
      `SELECT id FROM dashboard_agent_conversations
        WHERE organization_id = $1 AND user_id = $2
        LIMIT 1`,
      [org.orgId, operatorUserId(org.orgId)],
    );
    if (conv.rows.length === 0) {
      return reply.send({ conversationId: null, traces: [], nextCursor: null, truncated: false });
    }

    const conversationId = conv.rows[0].id;
    const page = await listOperatorTraces(app.controlDb, conversationId, {
      limit: Number.isFinite(parsedLimit) ? parsedLimit : 10,
      cursor: q.cursor ?? null,
      since,
      until,
      order: q.order === 'oldest' ? 'oldest' : 'newest',
    });
    return reply.send({ conversationId, ...page });
  });

  // ── POST /operator/approvals/:id/resolve ─────────────────────────────────
  //
  // Approve or deny an operator-raised gate. Unlike /approvals/:id/resolve
  // this does not STREAM a resumed turn — the operator's loop picks the
  // completed history up on its next wake. It does everything else resume.ts
  // does, via the same shared code: execute or deny the tool, write the
  // matching `role: 'tool'` row, clear pending_approval_id. Leaving those out
  // is what wedged the org's one operator conversation forever.
  //
  // Execution goes through executeOnce, which holds an advisory lock on the
  // approval id so a retried approve fires the tool once.
  app.post('/operator/approvals/:id/request-review', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });
    if (!z.object({}).strict().safeParse(request.body ?? {}).success) return reply.code(400).send({ error: 'No replacement operation is accepted.' });
    const userId = requireUserId(request);
    const org = await resolveCallerOrgId(app.controlDb, request, userId);
    if (!org.ok) return reply.code(org.code).send({ error: org.error });
    if (request.auth?.authMethod !== 'jwt' || !await isOrganizationOwner(app.controlDb, org.orgId, userId)) return reply.code(403).send({ error: 'An organization owner session is required.' });
    const { id } = request.params as { id: string };
    const approval = await getApprovalForOrg(app.controlDb, id, org.orgId);
    if (!approval) return reply.code(404).send({ error: 'approval not found' });
    const access = await evaluateOperatorAccess({ organizationId: org.orgId, actorUserId: userId, origin: approval.source, phase: 'run' });
    const outcome = await requestApprovalReview(app.controlDb, { approval, organizationId: org.orgId, actorUserId: userId, mayRun: access.allowed });
    if (!outcome.ok) return reply.code(409).send({ error: 'Review is resolved or execution requires reconciliation.' });
    return reply.send(outcome);
  });

  app.post('/operator/approvals/:id/resolve', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const org = await resolveCallerOrgId(app.controlDb, request, userId);
    if (!org.ok) return reply.code(org.code).send({ error: org.error });

    const parsed = resolveApprovalBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { id: approvalId } = request.params as { id: string };
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    if (parsed.data.status === 'approved') {
      const pending = await getApprovalForOrg(app.controlDb, approvalId, org.orgId);
      if (pending && await isOfficeClientConversation(app.controlDb, pending.conversationId)) return reply.code(409).send({ error: 'Use the Office client browser confirmation for this decision.', code: 'office_client_confirmation_required' });
    }
    const outcome = await resolveOperatorApproval(app.controlDb, {
      approvalId,
      orgId: org.orgId,
      jwt,
      userId,
      // Consequential Office approvals require a HUMAN session: a service or
      // API key can list and deny, but only a person (and, below, only an
      // owner) may authorise a deployment or live-data change.
      authMethod: request.auth?.authMethod,
      resolution:
        parsed.data.status === 'approved'
          ? { status: 'approved' }
          : { status: 'denied', reason: parsed.data.reason },
    });

    if (!outcome.ok) return reply.code(outcome.code).send({ error: outcome.error });
    const resolved = await getApprovalForOrg(app.controlDb, approvalId, org.orgId);
    return reply.send({ ok: true, ...(resolved ? { approval: await projectOrgApproval(app.controlDb, resolved, org.orgId, userId, request.auth?.authMethod) } : {}) });
  });

  // ── POST /approvals/:id/resolve ───────────────────────
  //
  // Approve or deny a gated tool call (Plan 3b Task 2's approval_required
  // pause), then stream the resumed turn's SSE events. See resume.ts for the
  // execute-then-persist steps that make the resumed history valid before
  // the agent loop is re-entered.
  app.post('/approvals/:id/resolve', async (request, reply) => {
    if (!isEnabled()) return reply.code(404).send({ error: 'not enabled' });

    const userId = requireUserId(request);
    const { id: approvalId } = request.params as { id: string };

    const parsed = resolveApprovalBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { status, trust_scope: trustScope, reason } = parsed.data;

    // Extract JWT verbatim from Authorization header, same as /messages.
    const authHeader = request.headers.authorization ?? '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // ── Ownership + provenance (Task 9) ────────────────────────────────────
    //
    // The approval must belong to the caller AND to a conversation the caller
    // can reach from the organization this request names. Checking that here,
    // before anything executes, is what keeps an Office approval from being
    // resolved through a different organization's context — and it is the
    // same 404 whether the conversation is missing or merely foreign, so
    // nothing leaks across the boundary.
    const approval = await getApproval(app.controlDb, approvalId, userId);
    if (!approval) {
      return reply.code(404).send({ error: 'approval not found' });
    }
    const conversation = await getConversation(app.controlDb, approval.conversationId, userId);
    if (!conversation || !isConversationReachableFromOrg(conversation, readOrgId(request))) {
      return reply.code(404).send({ error: 'approval not found' });
    }

    const isOffice = conversation.origin === 'office';
    const officeOrganizationId = isOffice ? conversation.organizationId : null;
    const clientCoordinated = isOffice && await isOfficeClientConversation(app.controlDb, conversation.id);
    if (clientCoordinated && status === 'approved') return reply.code(409).send({ error: 'Use the Office client browser confirmation for this decision.', code: 'office_client_confirmation_required' });

    /**
     * ── The Office consequential gate, foreground (Task 9) ────────────────
     *
     * Byte-for-byte the same contract as `resolveOperatorApproval`'s: a HUMAN
     * session, a CURRENT OWNER of the conversation's organization, an
     * entitlement that still allows execution, and a recorded immutable
     * operation. `office-conversations.test.ts` pins the member-asks /
     * owner-approves split through the org route; this route is the day the
     * approver is also the author, and it must not be a weaker path.
     *
     * Denial is NOT gated — refusing old work must remain possible with no
     * plan, no credits and no current owner.
     */
    if (isOffice && status === 'approved') {
      if (request.auth?.authMethod !== undefined && request.auth.authMethod !== 'jwt') {
        return reply.code(403).send({ error: 'a human organization-owner session is required to approve this action' });
      }
      if (!(await isOrganizationOwner(app.controlDb, officeOrganizationId as string, userId))) {
        return reply.code(403).send({ error: 'only an organization owner may approve this action' });
      }
      const access = await evaluateOperatorAccess({
        organizationId: officeOrganizationId as string,
        phase: 'execute',
        origin: 'office',
        actorUserId: userId,
        model: resolveAssistantModel(conversation.model),
      });
      if (!access.allowed) {
        return reply.code(409).send({ error: access.reason ?? 'service_unavailable' });
      }
      if (!approval.approvedOperation) {
        return reply.code(409).send({ error: 'approval_operation_missing: this approval must be re-proposed' });
      }
    }

    // Ownership + status checks, tool execution/denial-synthesis, and the
    // follow-up tool-result row are all done BEFORE any SSE headers are
    // sent — once hijacked we can't return a JSON 404/409/400.
    //
    // Office approvals execute through the SAME bridge the org feed uses —
    // executeOnce (exactly-once), the recorded-operation check, and the
    // substrate escalation cleanup. There is deliberately no second executor.
    const outcome = isOffice
      ? await completeApprovalResolution(app.controlDb, {
          approval,
          resolution:
            status === 'approved' ? { status: 'approved', trustScope } : { status: 'denied', reason },
          resolvedBy: userId,
          execute: (a, resolutionPool) =>
            executeApprovedOperatorTool(resolutionPool ?? app.controlDb, {
              approvalId: a.id,
              name: a.toolName,
              args: a.toolArgs,
              jwt,
              orgId: officeOrganizationId as string,
              traceId: a.traceId,
              approval: a,
              officeConsequential: true,
              actorUserId: userId,
              origin: 'office',
              cache: getSharedWorkingTreeCache(),
              treeStore: getSharedDeployTreeStore(),
            }),
          denyCleanup: (a, resolutionPool) =>
            rejectEscalatedSubstrateAction(resolutionPool ?? app.controlDb, {
              approvalId: a.id,
              approval: { toolName: a.toolName, toolArgs: a.toolArgs },
              reason,
              jwt,
              orgId: officeOrganizationId as string,
            }),
        })
      : await resolveApprovalAndPersistResult(app.controlDb, {
          approvalId,
          userId,
          jwt,
          resolution:
            status === 'approved' ? { status: 'approved', trustScope } : { status: 'denied', reason },
        });

    if (!outcome.ok) {
      return reply.code(outcome.code).send({ error: outcome.error });
    }

    const conversationId = outcome.approval.conversationId;

    // Begin SSE response — mirrors /messages.
    const requestOrigin = request.headers.origin;
    if (requestOrigin) {
      reply.raw.setHeader('access-control-allow-origin', requestOrigin);
      reply.raw.setHeader('vary', 'origin');
      reply.raw.setHeader('access-control-allow-credentials', 'true');
    }
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.setHeader('cache-control', 'no-cache');
    reply.raw.setHeader('connection', 'keep-alive');
    reply.hijack();

    let clientDisconnected = false;
    request.raw.on('close', () => {
      clientDisconnected = true;
      app.log.debug({ conversationId }, 'dashboard-agent resume SSE client disconnected');
    });

    try {
      // Read once above, before the hijack — no second lookup, and no chance
      // of the resumed turn running on a row the gate did not see.
      if (clientCoordinated) {
        const done = { type: 'done' as const };
        publishEvent(conversationId, done);
        if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(done)}\n\n`);
        return;
      }
      const model = resolveAssistantModel(conversation.model);

      // Empty userMessage: the resumed turn's history already contains the
      // just-persisted tool-result row (via resolveApprovalAndPersistResult).
      // The loop still appends a `role: 'user'` row per turn — an empty one
      // here is a harmless no-op line in history, not a duplicate prompt.
      const gen = runAgentTurn({
        conversationId,
        userId,
        jwt,
        userMessage: '',
        model,
        pool: app.controlDb,
        organizationId: readOrgId(request),
      });

      for await (const event of gen) {
        publishEvent(conversationId, event);
        if (clientDisconnected) continue;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errEvent = { type: 'error' as const, message: msg };
      publishEvent(conversationId, errEvent);
      if (!clientDisconnected) reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });
}
