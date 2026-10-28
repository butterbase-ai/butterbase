---
title: Office
description: An optional operator for a paid organization, with human approval for consequential work.
sidebar:
  order: 9
---

Office is an optional product for a paid organization. It adds an operator that
reviews the business records available to that organization, prepares useful
work, and brings decisions back to a person.

An owner can customize what Office watches and what it does with it by asking
for **skills** — standing instructions such as a morning check of a customer
sheet — and by connecting **Google Sheets** as a read-only source.

## Who can use it

An organization owner enables Office explicitly. Enabling is a single action,
not a questionnaire or an onboarding wizard. Other members can view an enabled
Office, but only an owner can enable it or approve the actions that need a
human.

Eligibility comes from the organization's plan. An owner's personal plan does
not grant Office to an organization they belong to, and a member cannot enable
it on the organization's behalf.

## What it may do on its own

Office may read the organization's available records, prepare work, write files
in a sandbox, and build. It may not deploy, contact a customer, or delete or
merge records without an owner's approval. An approval is for one recorded
operation and one set of arguments; a later code change is a new decision, not
a standing permission.

Skills guide what Office looks at and when. They do not grant capabilities
beyond this policy: a skill is instructions, not a new tool or a new
permission.

## Customizing Office with skills

A skill is a named piece of standing guidance: what to look at, when, and what
to bring back. An owner creates one by asking in plain language, for example
"Check the Customers sheet every morning and tell me who is missing a
follow-up." Office drafts the skill and shows it for review before it governs
any run. If an existing skill clearly matches the request, Office proposes an
update to it instead of a duplicate; if two could match, it asks rather than
guessing.

- **Review and approval.** Office runs a read-only test of a new or changed
  skill against real organization data, in a conversation other members cannot
  see. A skill cannot be approved until that test passes; a failed or blocked
  test — for example, no Google Sheets connection — leaves the previous version
  in charge. Only approval makes a version current; until then the previous
  version keeps running.
- **Versions.** Every change is a new version. The approved version is what
  scheduled runs use; earlier versions are kept, and an owner can restore one.
  Up to 20 versions are retained per skill, and an organization can have up to
  50 skills.
- **Schedules.** A skill carries a schedule — daily, weekdays, weekly, monthly,
  hourly, or at intervals of ten minutes or more — or it can be run on demand.
  Office checks schedules on the existing operator loop, so anything finer than
  every ten minutes is rejected; time spent paused or disabled is not caught up
  afterwards.
- **Runs and history.** Each run is recorded with the skill and version that
  produced it and appears in Office history; test runs are visible to owners
  only. "Run now" queues a manual run that uses the same policy as a scheduled
  one and can still ask for approval. A due run is recorded as skipped when an
  approval is pending, the Office is paused, or credits are unavailable.
- **What a skill can reach.** Skill scripts run in a sandbox with no network
  and no credentials. They can compute over the data the operator supplies;
  anything from outside arrives through a read the operator performs itself,
  never through the script. Skills carry no tool allowlist of their own — they
  cannot lift an approval or add a capability.
- **Who can change what.** Only an owner can create, edit, approve, enable,
  disable, restore, or run a skill. Members can view approved skills and
  non-test history.

## Google Sheets

Office can read a Google Sheet that an owner connects for the organization.
Open Office → Connections, choose Google Sheets, and complete the provider's
consent screen. The connection belongs to the organization, not to the person
who connected it.

- Reads are read-only: Office can read values, not change the sheet.
- If the connection is revoked or expires, skills that depend on it fail closed
  with a connection error until an owner reconnects it, and their tests cannot
  be approved.
- Disconnecting in Office removes the organization's connection. The
  provider-side grant can be removed from the provider's account settings.

## Billing

Model usage consumes the organization's AI credits. Office does not have a
separate token meter or a separate compute invoice, and it does not invent a
price for work. If credits or paid access stop, new work stops.

## When work stops

A downgrade, a suspended account, or exhausted credits stops new work without
discarding what already exists. Records, conversations and pending decisions
remain readable, and an owner can still decline a pending decision. Consequential
approvals resume when the organization can start work again.

The same applies to a broken credential: new work is unavailable until an owner
repairs setup, while the records stay where they are.

## If a skill run is skipped or blocked

- **Connection required** — reconnect Google Sheets in Office → Connections,
  then ask Office to re-test the skill.
- **Test has not passed** — approval stays disabled until a new test passes.
- **Run in progress** — wait for the queued or running occurrence to finish.
- **Approval pending** — a due run is skipped while an earlier version of a
  skill is waiting for approval; approve or decline it and the next occurrence
  runs normally.
- **Interrupted run** — if a turn stops mid-run, the run is closed
  automatically and the next scheduled occurrence is the retry; nothing needs
  fixing by hand.
- **Paused or out of credits** — the occurrence is recorded as skipped and is
  not caught up when work resumes.
- **Sandbox unavailable** — the deployment has no isolated runner; contact
  support.
