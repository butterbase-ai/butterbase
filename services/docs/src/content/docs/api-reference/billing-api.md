---
title: Billing API
description: Complete reference for billing, usage, and Stripe Connect endpoints.
sidebar:
  order: 7
---

## Platform billing

| Method | Path | Purpose |
|--------|------|---------|
| GET | /dashboard/billing | Current plan, usage, and limits |
| GET | /dashboard/usage | Daily usage history |
| POST | /dashboard/billing/checkout | Start upgrade checkout |
| POST | /dashboard/billing/portal | Open billing portal |

### Usage history

```
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_tokens
```

| Parameter | Description |
|-----------|-------------|
| `startDate` | Start of range (ISO date) |
| `endDate` | End of range (ISO date) |
| `meterType` | Filter: `storage_bytes`, `ai_tokens`, `lambda_invocations`, `bandwidth_bytes` |

## Stripe Connect (monetization)

### Developer endpoints (platform auth)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/connect/onboard | Start Connect onboarding |
| GET | /v1/\{app_id}/billing/connect/status | Check onboarding status |

### Subscription plans

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/plans | Create a plan |
| GET | /v1/\{app_id}/billing/plans | List plans |
| PUT | /v1/\{app_id}/billing/plans/\{plan_id} | Update a plan |

**Create:**

```json
{
  "name": "Pro Plan",
  "priceCents": 999,
  "interval": "month",
  "features": ["Feature 1", "Feature 2"]
}
```

### Products (one-time purchases)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/products | Create a product |
| GET | /v1/\{app_id}/billing/products | List products |
| PUT | /v1/\{app_id}/billing/products/\{product_id} | Update a product |

**Create:**

```json
{
  "name": "Premium Template",
  "priceCents": 2999,
  "description": "50+ templates",
  "metadata": { "category": "templates" }
}
```

### End user endpoints (app JWT)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/subscribe | Start subscription |
| GET | /v1/\{app_id}/billing/subscription | Current subscription |
| POST | /v1/\{app_id}/billing/cancel | Cancel at period end |
| POST | /v1/\{app_id}/billing/purchase | Purchase a product |
| GET | /v1/\{app_id}/billing/orders | List orders |
| GET | /v1/\{app_id}/billing/orders/{order_id} | Get order details |

### Webhooks

```
POST /webhooks/stripe/connect
```

Set `STRIPE_CONNECT_WEBHOOK_SECRET` in the control API environment.

Handled events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `payment_intent.payment_failed`, `charge.refunded`
