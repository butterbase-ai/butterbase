---
title: Monetization
description: Sell subscriptions and products to your end users using Stripe Connect.
---

Butterbase includes built-in Stripe Connect support so you can sell subscriptions and one-time products to your app's end users. This is separate from your own Butterbase subscription — it's for monetizing the product you build.

## How it works

1. Onboard a Stripe Connect account for your app
2. Define subscription plans or products with pricing
3. Your end users subscribe or purchase through Checkout sessions managed by the platform

## Setting up Stripe Connect

### Step 1: Onboard your Connect account

```
POST /v1/{app_id}/billing/connect/onboard
```

Returns `accountId` and `onboardingUrl`. Complete the setup in Stripe.

### Step 2: Check onboarding status

```
GET /v1/{app_id}/billing/connect/status
```

Returns whether Connect onboarding is complete and payouts are ready.

## Subscriptions

### Developer endpoints (platform auth)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/plans | Create a subscription plan |
| GET | /v1/\{app_id}/billing/plans | List plans (public catalog) |
| PUT | /v1/\{app_id}/billing/plans/\{plan_id} | Update plan fields |

**Create a plan:**

```json
POST /v1/{app_id}/billing/plans

{
  "name": "Pro Plan",
  "priceCents": 999,
  "interval": "month",
  "features": ["Unlimited projects", "Priority support", "Custom domain"]
}
```

### End user endpoints (app JWT)

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/subscribe | Start a subscription |
| GET | /v1/\{app_id}/billing/subscription | Current subscription |
| POST | /v1/\{app_id}/billing/cancel | Cancel at period end |

**Subscribe:**

```json
POST /v1/{app_id}/billing/subscribe

{
  "planId": "uuid-of-plan",
  "successUrl": "https://yourapp.com/billing/success",
  "cancelUrl": "https://yourapp.com/billing/cancel"
}
```

Returns a Stripe Checkout `url` for the user to complete payment.

## One-time purchases

For selling digital products, physical goods, or one-time access.

### Developer endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/products | Create a product |
| GET | /v1/\{app_id}/billing/products | List products (public catalog) |
| PUT | /v1/\{app_id}/billing/products/\{product_id} | Update product |

**Create a product:**

```json
POST /v1/{app_id}/billing/products

{
  "name": "Premium Template Pack",
  "priceCents": 2999,
  "description": "50+ premium UI templates",
  "metadata": { "category": "templates" }
}
```

### End user endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/purchase | Purchase a product |
| GET | /v1/\{app_id}/billing/orders | List all orders |
| GET | /v1/\{app_id}/billing/orders/{order_id} | Get order details |

### Order statuses

| Status | Meaning |
|--------|---------|
| `pending` | Checkout session created, payment not yet completed |
| `paid` | Payment successful |
| `failed` | Payment failed |
| `refunded` | Payment was refunded |

## Webhooks

Stripe sends Connect events to `POST /webhooks/stripe/connect`. Configure the endpoint and signing secret in your Stripe dashboard and set `STRIPE_CONNECT_WEBHOOK_SECRET` in the control API environment.

The platform handles:
- `checkout.session.completed` (subscriptions and payments)
- `customer.subscription.updated` / `deleted`
- `invoice.payment_succeeded` / `failed`
- `payment_intent.payment_failed`
- `charge.refunded`

## Example flow (subscriptions)

1. Developer creates plan: `POST /v1/{app_id}/billing/plans`
2. End user subscribes: `POST /v1/{app_id}/billing/subscribe`
3. User completes payment in Stripe Checkout
4. Webhook fires, subscription activates
5. User can check status: `GET /v1/{app_id}/billing/subscription`

## Alternative approach

If you don't need Connect, you can build checkout flows yourself using Stripe directly in a [serverless function](/core-concepts/functions) and store purchase state in your app tables.
