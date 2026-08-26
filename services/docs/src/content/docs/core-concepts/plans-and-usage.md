---
title: Plans & Usage
description: What Butterbase charges you — usage meters, AI credits, top-ups, spending caps, and what happens at your limits.
---

This page is about what **Butterbase charges you** for running your backend.

For charging **your own end users**, see [Charging Your Users](/core-concepts/billing/).

## Plans

Plans are billed per **organization**, and every account starts on the free tier. Tiers differ on AI credits, project count, MAU, database size, bandwidth, file storage, function invocations, frontend deployments, request rate, realtime listeners, KV limits, [custom domains](/core-concepts/custom-domains/), support level, and compliance add-ons.

Current tiers, prices, and allowances live in two canonical places — deliberately not duplicated here, because they change:

- **[butterbase.ai/pricing](https://butterbase.ai/pricing)** — the tier comparison
- **[Your dashboard Billing page](https://dashboard.butterbase.ai/billing)** — what *your* organization is actually on, with live usage against each limit

```bash
butterbase billing status
```

Free-tier projects are paused after a week of inactivity. Resume them from the dashboard.

## Usage meters

| Meter | What it measures |
|-------|-----------------|
| `ai_credits` | AI model usage cost, in dollars |
| `storage_bytes` | Total file storage across all apps in the org |
| `lambda_invocations` | Total function executions |
| `bandwidth_bytes` | Data transferred out |

## Credits, top-ups, and spending caps

AI usage draws down a single credit balance per organization, in this order:

1. **Monthly allowance** — a per-tier credit grant, refilled on each successful subscription invoice.
2. **Top-up balance** — pay-as-you-go credit you buy in advance; never expires.
3. **Overage** — paid tiers keep serving past zero, down to a per-tier **credit floor**, then hard-stop. The free tier has a floor of $0 and stops the moment the balance is exhausted.

**Buy a top-up:**

```
POST /dashboard/billing/topup
{ "amount": 25 }
```

```bash
butterbase billing topup 25
```

**Spending cap** — an org-level ceiling on AI spend. Paid tiers get a default cap; when you hit it, AI calls are refused until you raise it. Your current cap and floor are on the dashboard Billing page.

```bash
butterbase billing cap get
butterbase billing cap raise --raise-by 50
```

**Auto-refill** — optionally top up automatically when the balance drops below a threshold. Configure it on the dashboard Billing page.

## Checking your usage

```
GET /dashboard/billing
```

Returns current plan, limits, usage percentages, credit balance, and spending cap.

```
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_credits
```

Returns daily usage over a date range.

```bash
butterbase billing status
butterbase billing usage --start 2026-01-01 --end 2026-01-31 --meter ai_credits
```

## Upgrading your plan

```json
POST /dashboard/billing/checkout
{ "planId": "<plan-id>" }
```

Returns a Stripe Checkout `url`. Limits update immediately after payment succeeds.

## Managing your subscription

```
POST /dashboard/billing/portal
```

Returns a URL to the Stripe self-service portal — update payment methods, download invoices, cancel.

```bash
butterbase billing portal
```

## What happens when you exceed a limit

**Free tier:** the org is soft-locked. Reads still work; writes are blocked until usage drops or you upgrade.

**Paid plans:** usage past an allowance is not blocked — overage is billed at your tier's per-meter rate. You get an email. If a payment fails, a grace period begins; after it expires the org is suspended.

## Account statuses

| Status | Meaning |
|--------|---------|
| `active` | Normal operation |
| `soft_locked` | Free-tier limits exceeded |
| `suspended` | Payment failure past the grace period |

---

