---
title: Office
description: An optional operator for a paid organization, with human approval for consequential work.
sidebar:
  order: 9
---

Office is an optional product for a paid organization. It adds an operator that
reviews the business records available to that organization, prepares useful
work, and brings decisions back to a person.

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
