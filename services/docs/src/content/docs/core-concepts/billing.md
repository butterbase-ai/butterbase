---
title: Billing & Plans
description: Free, Pro, and Enterprise plans with usage-based metering and overage handling.
---

Butterbase offers three plan tiers with monthly usage allowances.

## Plans

| | Free | Pro | Enterprise |
|---|---|---|---|
| **Price** | $0/mo | $25/mo | Custom |
| **AI credits** | $0.10 (lifetime) | $10/mo (then $0.10/credit) | Unlimited |
| **MAU** | 50,000 | 100,000 (then $0.00325/MAU) | Unlimited |
| **Database size** | 500 MB | 8 GB (then $0.125/GB) | Unlimited |
| **Bandwidth** | 5 GB | 250 GB (then $0.09/GB) | Unlimited |
| **File storage** | 1 GB | 100 GB (then $0.021/GB) | Unlimited |
| **Function invocations** | 50,000/mo | 500,000/mo | Unlimited |
| **Custom domain** | — | Yes | Yes |
| **Priority support** | — | Yes | Yes |
| **SOC2** | — | — | Yes |
| **SSO** | — | — | Yes |
| **HIPAA** | — | — | Paid add-on |
| **SLA** | — | — | Yes |

Free projects are paused after 1 week of inactivity.

## Usage meters

| Meter | What it measures |
|-------|-----------------|
| **ai_credits** | AI model usage cost |
| **storage_bytes** | Total file storage across all apps |
| **lambda_invocations** | Total function executions |
| **bandwidth_bytes** | Data transferred out |

## Checking your usage

View current usage, plan limits, and usage percentages through the dashboard or API:

```
GET /dashboard/billing
```

## Usage history

View daily usage over a date range:

```
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_tokens
```

## Upgrading your plan

```json
POST /dashboard/billing/checkout
{ "planId": "pro" }
```

Returns a URL to complete payment. Limits are updated immediately after payment.

## Managing your subscription

```
POST /dashboard/billing/portal
```

Returns a URL to the self-service billing portal (update payment methods, view invoices, cancel).

## What happens when you exceed a limit

**Free plan:** Your account is soft-locked. Read operations still work, but write operations are blocked until usage drops or you upgrade.

**Pro plan:** Usage beyond limits is not blocked — overage charges apply at the rates shown above. You'll receive an email notification. If payment fails, a 7-day grace period begins. After that, the account is suspended.

## Account statuses

| Status | Meaning |
|--------|---------|
| `active` | Normal operation |
| `soft_locked` | Free plan limits exceeded |
| `suspended` | Payment failure past grace period |

## Monetization

Want to sell subscriptions or products to your own end users? See the [Monetization guide](/guides/monetization).
