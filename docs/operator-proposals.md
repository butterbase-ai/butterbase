# Structured operator proposals

An Office owner approves one frozen operation. The explanation, the proposed
effect, supporting records and execution result are separate parts of its review.

## Preparing a proposal

`propose_action` is a local Office/operator tool. It is offered only when the
deployment has enabled its preparation provider. It is not a public MCP tool,
SDK method, or a tool that can be executed by replaying a human approval.

```json
{
  "operation": {
    "tool": "manage_substrate",
    "arguments": { "action": "cancel_outbox", "outbox_id": "obx_example" }
  },
  "reason": "The original draft was replaced and should not be sent.",
  "evidence_refs": [{ "kind": "artifact", "id": "art_example" }]
}
```

The reason is trimmed and must contain 1–2000 characters. Supporting records
are optional: zero to ten references. References may identify an entity,
artifact, learning, decision, commitment, app, storage object, or authorized
conversation message. File references contain `app_id` and stable `object_id`;
message references contain `conversation_id` and `message_id`. Reference labels
and previews come from the server. A reference's existence and accessibility do
not prove the operator's explanation.

Do not supply a title, preview, organization, policy verdict or evidence label.
Preparation validates actual executable contracts without running handlers,
checks the organization's target and references, and freezes material facts.
Unknown or unsupported operations return `proposal_unreviewable`; they never
become generic approvable requests.

An intercepted consequential call without an explicit reason returns
`proposal_incomplete` to the operator. Call the wrapper with the same operation
and a reason. Do not turn unrelated assistant text or a scheduled sweep into
the owner's intent. Existing automatic operations retain their direct path;
the wrapper returns `proposal_not_required` and executes nothing for them.

When substrate parks a normally automatic operation, its server-issued result
is recorded before the operator supplies review details. Completion uses that
existing action. Do not propose it again, supply an arbitrary `approve` call,
or resolve the owner's own queue from agent code.

Substrate replay keys bind the normalized capability, payload and trusted
application/rule scope within the organization. Matched replays return the
existing action's actual `status`. Reusing a key for different work, or replaying
an ambiguous historical key, returns `409 idempotency_intent_conflict` rather
than authorizing a different action. New work needs its own key and review.

## Reviewing and resolving

The authenticated approval detail adds `approval.review`:

- `reviewStatus`: `ready`, `stale`, `unavailable`, or `legacy`;
- a safe prepared preview, attributed operator reason and accessible references;
- independent `executionOutcome` and `permittedActions`.

The public demo omits this private review. Its browser-only answers do not
resolve approvals or execute operations.

`POST /v1/dashboard-agent/operator/approvals/:id/resolve` accepts only the
resolution fields. Request arguments, preview and operation cannot be replaced
in that body. Current authorization, schemas, immutable artifacts and material
facts are rechecked before dispatch. Changed facts expire the old gate and
complete its original model call; another owner review is required. Temporarily
unavailable reads fail closed and remain retryable.

For a legacy or insufficient gate, an owner can call
`POST /v1/dashboard-agent/operator/approvals/:id/request-review` with `{}`. This
expires that gate and records a request to prepare the same frozen operation.
It does not approve, execute or invent a reason. Paused work retains the request
until a permitted runner can resume it. Denial is separate and is not consent
to propose the operation again.

The optional authenticated list query `?history=1` returns pending `approvals`
and up to 50 recent resolved reviews in `history`, scoped to the organization.
It also returns a separate `preparations` collection. Preparation is not
execution: requests move through `waiting`, `running`, `replaced`, `blocked`
or `failed` in `dashboard_agent_review_preparations` (migration 135). A
failed or blocked request stays visible and can be retried explicitly by the
owner. Already-expired `proposal_review_required` records are recoverable;
other expired, successful or uncertain executions are not retry shortcuts.

Preparation of a delivery cancellation is refused while that delivery is in
flight. It leaves the delivery unchanged and creates no execution or replacement
approval. Reconcile the delivery state before requesting preparation again.

The source approval ID makes repeated requests idempotent. Claims carry a
twenty-minute lease and token. Only a matching frozen intent, organization,
conversation and current lease can link a persisted replacement atomically.
Provider errors, preparation refusal, or a turn ending without a replacement
record an unsuccessful preparation; assistant prose does not settle a request.
Explicit preparation input is injected by the operator runner, not appended
by the request endpoint after a potentially unanswered tool call. Focused
preparation turns report `preparationAttempted` so a scheduler cannot count
them as a completed full reconciliation sweep.

Executable arguments stay server-side; credential-named display fields are
redacted. Arbitrary source code is displayed inertly and is not promised to be
secret-free or to have fully predicted downstream effects.

## Execution reporting and recovery

Decision status is independent of execution: `not_started`, `running`,
`succeeded`, `failed`, or `unconfirmed`. Missing legacy metadata does not prove
that an action never ran. A successful HTTP resolution response alone is not
the execution-success signal.

Confirmed cached execution can finish interrupted transcript completion without
repeating the effect. A known failure remains pending and retryable. A running
or ambiguous attempt with no confirmed result requires reconciliation; it must
not automatically repeat a possibly completed effect. A confirmed effect cannot
later be relabeled as a denial because transcript completion was interrupted.

Uncertain responses also leave a negative execution receipt. This applies to
older approvals and to the native approval leg after a proposal was parked.
A lost response or an exception after dispatch cannot silently cause another
request. Review refresh checks this receipt even if its outcome projection is
missing. Only an explicit trusted no-effect refusal remains retryable.

Concurrent resolutions serialize around the existing execution cache. This
prevents duplicate callers from dispatching together; it does not make remote
side effects universally crash-proof or exactly once across every failure.

Deployment is additive: compatibility readers and resolvers must be installed
before enabling new writers. Disabling writers never disables checks on an
existing prepared proposal. Keep compatibility code and columns while such
proposals remain pending; follow the deployment-specific rollback runbook.
