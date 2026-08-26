---
title: Billing & Plans
description: What Butterbase charges you for your backend, and how to charge your own end users with Stripe Connect.
---

There are two completely separate money flows in Butterbase. Keep them straight and everything else on this page makes sense.

| | **Platform billing** | **App billing (monetization)** |
|---|---|---|
| Who pays whom | You pay Butterbase | Your end users pay **you** |
| What it covers | Your backend: database, functions, bandwidth, AI credits | Whatever you sell: subscriptions, digital products, access |
| Where the money lands | Butterbase | **Your own Stripe account** |
| Configured at | Organization level (`/billing` in the dashboard) | Per app (**App → Monetization**) |
| Butterbase's cut | n/a | **0%** — Butterbase takes no platform fee |
| Read | [Part 1](#part-1-what-butterbase-charges-you) | [Part 2](#part-2-how-to-charge-your-own-users) |

---

# Part 1: What Butterbase charges you

## Plans

Plans are billed per **organization**. Every account starts on Playground.

| | Playground | Launch | Certified | Enterprise |
|---|---|---|---|---|
| **Price** | $0 | $19/mo | $90/mo | Custom |
| **AI credits included** | $1.00 (lifetime) | $5/mo | $15/mo | Custom |
| **AI overage rate** | — (hard stop) | $0.10/credit | $0.08/credit | Custom |
| **Projects (apps)** | 1 | 3 | 10 | Unlimited |
| **MAU** | 10,000 | 50,000 (then $0.00325/MAU) | 100,000 (then $0.00325/MAU) | Unlimited |
| **Database size** | 0.5 GB | 4 GB (then $0.125/GB) | 8 GB (then $0.125/GB) | Unlimited |
| **Bandwidth** | 5 GB | 100 GB (then $0.09/GB) | 250 GB (then $0.09/GB) | Unlimited |
| **File storage** | 1 GB | 50 GB (then $0.021/GB) | 100 GB (then $0.021/GB) | Unlimited |
| **Function invocations** | 50,000/mo | 500,000/mo | 1,000,000/mo | Unlimited |
| **Frontend deployments** | 2 | 10 | 25 | Unlimited |
| **Requests/min** | 300 | 3,000 | 3,000 | Unlimited |
| **Realtime listeners/app** | 20 | 200 | 200 | Unlimited |
| **SQL statement timeout** | 15s | 30s | 30s | 60s |
| **KV ops/sec** | 50 | 1,000 | 1,000 | Unlimited |
| **KV storage** | 10 MB | 1 GB | 1 GB | Unlimited |
| **[Custom domains](/core-concepts/custom-domains/)** | — | Yes | Yes | Yes |
| **Priority support** | — | — | Yes | Yes |
| **SOC2 / SSO / SLA** | — | — | — | Yes |
| **HIPAA** | — | — | — | Paid add-on |

:::note
Allowances are read live from your account — the dashboard's [Billing page](https://dashboard.butterbase.ai/billing) and [butterbase.ai/pricing](https://butterbase.ai/pricing) are canonical if this table ever drifts.
:::

Playground projects are paused after a week of inactivity. Resume them from the dashboard.

## Usage meters

| Meter | What it measures |
|-------|-----------------|
| `ai_credits` | AI model usage cost, in dollars |
| `storage_bytes` | Total file storage across all apps in the org |
| `lambda_invocations` | Total function executions |
| `bandwidth_bytes` | Data transferred out |

## Credits, top-ups, and spending caps

AI usage draws down a single credit balance per organization, in this order:

1. **Monthly allowance** — refilled on each successful subscription invoice (Launch $5, Certified $15).
2. **Top-up balance** — pay-as-you-go credit you buy in advance; never expires.
3. **Overage** — paid tiers keep serving past zero, down to a per-tier credit floor (Launch −$10, Certified −$25, Enterprise −$50), then hard-stop. Playground has a floor of $0 and stops immediately.

**Buy a top-up:**

```
POST /dashboard/billing/topup
{ "amount": 25 }
```

```bash
butterbase billing topup 25
```

**Spending cap** — an org-level ceiling on AI spend (default $20 on Launch, $50 on Certified). When you hit it, AI calls are refused until you raise it.

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
{ "planId": "launch" }
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

**Playground:** the org is soft-locked. Reads still work; writes are blocked until usage drops or you upgrade.

**Paid plans:** usage past an allowance is not blocked — overage is billed at the rates above. You get an email. If a payment fails, a grace period begins; after it expires the org is suspended.

## Account statuses

| Status | Meaning |
|--------|---------|
| `active` | Normal operation |
| `soft_locked` | Playground limits exceeded |
| `suspended` | Payment failure past the grace period |

---

# Part 2: How to charge your own users

Butterbase ships a complete **Stripe Connect** integration so your app can take money from its own users — subscriptions, one-time products, or both. You do not write Stripe code, host a checkout page, or run a webhook server.

### What you get

- **Money goes straight to your Stripe account.** Butterbase creates a Stripe Express account owned by you; charges are made *on* that account, and Stripe pays out to your bank.
- **0% platform fee.** Butterbase takes no cut of Connect transactions — `platform_fee_cents` is always `0`. You pay Stripe's normal processing fees and nothing else.
- **Hosted checkout.** Every purchase returns a Stripe Checkout URL. PCI scope stays with Stripe.
- **Webhooks already handled.** Subscription activation, renewal, failure, cancellation, and refunds are processed for you and written to your app's tables.
- **A subscription/order model in your database.** `app_plans`, `app_products`, `app_subscriptions`, and `app_orders` are queryable from your functions and RLS policies.
- **Works everywhere.** Dashboard UI, REST API, CLI (`butterbase app-billing`), TypeScript SDK (`bb.billing.*`), and MCP.

### Before you begin

- [ ] Your app is created and its **users sign in through Butterbase Auth** — checkout needs a real row in `app_users` with an email. See [Authentication](/core-concepts/authentication/).
- [ ] You have (or can create) a Stripe account, and you can complete Stripe's identity/bank verification for your country.
- [ ] You know which model you want: recurring **plans**, one-time **products**, or both.
- [ ] You have a `successUrl` and `cancelUrl` in your frontend for Stripe to return users to.

## Step 1 — Onboard your Stripe Connect account

This creates a Stripe Express account for the app and hands you a Stripe-hosted onboarding link.

**Dashboard (recommended):** go to **App → Monetization → Stripe Connect → Connect with Stripe**. You'll be redirected to Stripe, then back to the dashboard.

**REST API:**

```
POST /v1/{app_id}/billing/connect/onboard
Authorization: Bearer {platform_api_key}
```

```json
{
  "accountId": "acct_1Nv...",
  "onboardingUrl": "https://connect.stripe.com/setup/e/acct_1Nv.../..."
}
```

**SDK:**

```typescript
const { data } = await bb.billing.connectOnboard();
window.location.href = data.onboardingUrl;
```

:::caution
Only the **app owner** can call the Connect and plan/product endpoints. A non-owner org member gets `403 Not authorized`.
:::

Open `onboardingUrl` and complete Stripe's flow — business details, identity verification, and a payout bank account. The link is single-use and expires; call the endpoint again to get a fresh one. It is normal for this to take a few minutes, and for some countries Stripe may hold `payouts_enabled` until it finishes reviewing your documents.

## Step 2 — Confirm you can accept payments

```
GET /v1/{app_id}/billing/connect/status
```

```json
{
  "accountId": "acct_1Nv...",
  "chargesEnabled": true,
  "detailsSubmitted": true,
  "payoutsEnabled": true
}
```

| Field | Must be `true` before… |
|-------|------------------------|
| `detailsSubmitted` | Stripe considers onboarding finished |
| `chargesEnabled` | **any checkout will work** — Butterbase refuses to create a session without it (`CONNECT_NOT_READY`) |
| `payoutsEnabled` | Stripe will actually move money to your bank |

If `chargesEnabled` is `false`, re-run Step 1 and finish whatever Stripe is still asking for.

## Step 3 — Choose your pricing model

| You want to sell | Use | Objects created |
|---|---|---|
| Monthly or yearly access | **Plans** | `app_plans` → `app_subscriptions` |
| A one-off purchase (digital goods, credits, lifetime access) | **Products** | `app_products` → `app_orders` |
| Both | Both | — |

Plans and products are independent; an app can have any number of each.

## Step 4a — Create subscription plans

```json
POST /v1/{app_id}/billing/plans
Authorization: Bearer {platform_api_key}

{
  "name": "Pro",
  "priceCents": 999,
  "interval": "month",
  "features": ["Unlimited projects", "Priority support", "Custom domain"]
}
```

| Field | Type | Notes |
|-------|------|-------|
| `name` | string, 1–100 chars | Shown on the Stripe Checkout line item |
| `priceCents` | integer ≥ 0 | **Cents.** `999` = $9.99. Subscriptions are charged in USD. |
| `interval` | `"month"` \| `"year"` | Defaults to `"month"` |
| `features` | string[] | Free-form marketing bullets — your UI decides what to do with them |

The response is the created row, including the `id` (a UUID) you'll pass to `subscribe`.

```bash
butterbase app-billing plans create --name "Pro" --price-cents 999 --interval month
butterbase app-billing plans list
```

```typescript
const { data: plan } = await bb.billing.createPlan({
  name: 'Pro', priceCents: 999, interval: 'month',
  features: ['Unlimited projects', 'Priority support'],
});
```

**Changing a plan:**

```json
PUT /v1/{app_id}/billing/plans/{plan_id}
{ "priceCents": 1299, "active": true }
```

You can update `name`, `priceCents`, `features`, and `active`. You cannot change `interval` — create a new plan instead. Setting `active: false` retires a plan: it stops accepting new subscribers, and existing subscriptions keep running.

:::note
Price changes apply to **new** checkouts only. Existing subscribers stay on the price they signed up at until they resubscribe.
:::

## Step 4b — Create one-time products

```json
POST /v1/{app_id}/billing/products
Authorization: Bearer {platform_api_key}

{
  "name": "Premium Template Pack",
  "description": "50+ premium UI templates",
  "priceCents": 2999,
  "metadata": { "category": "templates", "sku": "TPL-50" }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `name` | string, 1–100 chars | Checkout line item |
| `description` | string, ≤ 500 chars | Optional; shown at checkout |
| `priceCents` | integer ≥ 0 | Cents |
| `metadata` | `Record<string,string>` | Your own keys — comes back on the order, use it to drive fulfillment |

Currency defaults to `usd`. Update with `PUT /v1/{app_id}/billing/products/{product_id}` (`name`, `description`, `priceCents`, `active`, `metadata`).

```bash
butterbase app-billing products create --name "Template Pack" --price-cents 2999
```

## Step 5 — Show the catalog in your app

Listing plans and products is **public** — no auth needed, so you can render a pricing page to logged-out visitors.

```
GET /v1/{app_id}/billing/plans      → { "plans":   [...] }
GET /v1/{app_id}/billing/products   → { "products": [...] }
```

```typescript
const { data: plans } = await bb.billing.listPlans();
const { data: products } = await bb.billing.listProducts();
```

Filter out rows where `active` is `false` before rendering — inactive rows are still returned so historical subscriptions can resolve their plan name.

## Step 6 — Send a user to checkout

:::danger
This is the step people get wrong. `subscribe` and `purchase` must be called **as the end user** — with the app JWT your user got from Butterbase Auth, *not* your platform API key. The user id in that token is who gets the subscription.
:::

**Subscribe:**

```json
POST /v1/{app_id}/billing/subscribe
Authorization: Bearer {end_user_app_jwt}

{
  "planId": "3f9a…-uuid",
  "successUrl": "https://yourapp.com/billing/success",
  "cancelUrl":  "https://yourapp.com/pricing"
}
```

```json
{ "sessionId": "cs_live_…", "url": "https://checkout.stripe.com/c/pay/cs_live_…" }
```

**Purchase:**

```json
POST /v1/{app_id}/billing/purchase
Authorization: Bearer {end_user_app_jwt}

{ "productId": "8b21…-uuid", "successUrl": "…", "cancelUrl": "…" }
```

```json
{ "sessionId": "cs_live_…", "url": "https://checkout.stripe.com/…", "orderId": "0c7d…-uuid" }
```

A `pending` row is written to `app_orders` **before** checkout opens, so you always have an id to correlate against.

Then redirect:

```typescript
const { data, error } = await bb.billing.subscribe({
  planId: plan.id,
  successUrl: `${window.location.origin}/billing/success`,
  cancelUrl: `${window.location.origin}/pricing`,
});
if (error) return showError(error);
window.location.href = data.url;
```

`successUrl` / `cancelUrl` are optional but you should always set them — the defaults point at the Butterbase dashboard, not your app.

## Step 7 — Understand what happens after payment

Payment is not final when the user returns to `successUrl`. It's final when Stripe confirms it. Butterbase runs the Connect webhook handler and writes the result into your app's tables:

| Stripe event | What Butterbase does |
|-------|----------------------|
| `checkout.session.completed` | Activates the subscription, or marks the order `paid` |
| `invoice.paid` | Rolls the subscription period forward |
| `invoice.payment_failed` | Marks the subscription `past_due` |
| `customer.subscription.updated` | Syncs status and `cancel_at_period_end` |
| `customer.subscription.deleted` | Marks the subscription canceled |
| `payment_intent.payment_failed` | Marks the order `failed` |
| `charge.refunded` | Marks the order `refunded`, stamps `refunded_at` |

Events are deduplicated by Stripe event id, so retries are safe.

**On Butterbase Cloud there is nothing to configure.** Your Express account's events flow to the platform endpoint automatically. Write your app to read state from `GET /billing/subscription` and `GET /billing/orders` — do not try to grant access from the `successUrl` redirect alone, because the webhook may land a moment later.

:::note[Self-hosting only]
If you run your own control API, register a Stripe webhook endpoint at `https://<your-control-api>/webhooks/stripe/connect`, enable **"Listen to events on Connected accounts"** (Connect events carry an `account` field, and the handler skips any event without one), subscribe to the events above, and set the signing secret as `STRIPE_CONNECT_WEBHOOK_SECRET` in the control API environment.
:::

## Step 8 — Gate access on subscription status

```
GET /v1/{app_id}/billing/subscription
Authorization: Bearer {end_user_app_jwt}
```

```json
{
  "subscription": {
    "id": "…", "plan_id": "…", "status": "active",
    "current_period_start": "2026-08-01T00:00:00Z",
    "current_period_end":   "2026-09-01T00:00:00Z",
    "cancel_at_period_end": false,
    "plan_name": "Pro", "price_cents": 999, "interval": "month",
    "features": ["Unlimited projects"]
  }
}
```

Returns `{ "subscription": null }` when the user has none. Only `active`, `trialing`, and `past_due` subscriptions are returned — a canceled or expired one reads as `null`, which is exactly the check you want:

```typescript
const { data: sub } = await bb.billing.getSubscription();
const isPro = sub !== null && sub.status === 'active';
```

**Enforce it on the server, not just in the UI.** The reliable pattern is a [serverless function](/core-concepts/functions/) that queries `app_subscriptions` for the caller before doing paid work:

```sql
SELECT 1 FROM app_subscriptions
WHERE app_id = $1 AND user_id = $2
  AND status IN ('active', 'trialing')
  AND current_period_end > now();
```

You can also drive [row-level security](/core-concepts/row-level-security/) policies from the same table so premium rows are unreadable without a live subscription.

## Step 9 — Cancellation

```
POST /v1/{app_id}/billing/cancel
Authorization: Bearer {end_user_app_jwt}
```

Sets `cancel_at_period_end = true`. The user keeps access until `current_period_end`, then Stripe emits `customer.subscription.deleted` and the subscription stops being returned. Returns `404` if there's no active subscription.

There is no "resume" endpoint — a user who changes their mind subscribes again.

## Step 10 — Fulfilling one-time purchases

```
GET /v1/{app_id}/billing/orders            → { "orders": [...] }
GET /v1/{app_id}/billing/orders/{order_id} → one order
```

Both are end-user scoped: a user only ever sees their own orders.

| Status | Meaning |
|--------|---------|
| `pending` | Checkout session created, payment not completed |
| `paid` | Payment succeeded — **fulfill here** |
| `failed` | Payment failed |
| `refunded` | Refunded; `refunded_at` is set |

Never grant access on `pending`. Poll for `paid` from your success page, or read the order inside a function before serving the purchased asset. The product's `metadata` comes back on the order — use it to decide what to deliver.

## Testing before you launch

1. Put your Stripe account in **test mode** and complete Connect onboarding with Stripe's test business details.
2. Create a cheap plan and product.
3. Sign in to your app as a real end user and hit `subscribe` / `purchase`.
4. Pay with `4242 4242 4242 4242`, any future expiry, any CVC. Use `4000 0000 0000 0341` to test a failed payment.
5. Confirm the webhook fired: `GET /billing/subscription` flips to `active`, or the order flips to `paid`.
6. Test the cancel path and the refund path (refund the charge in Stripe, confirm the order flips to `refunded`).

## Going-live checklist

- [ ] `connect/status` shows `chargesEnabled` **and** `payoutsEnabled`
- [ ] Every plan/product you don't want sold is `active: false`
- [ ] `successUrl` / `cancelUrl` point at your domain, not the dashboard
- [ ] Access is enforced server-side, not only in the frontend
- [ ] You have terms of service and a refund policy — Stripe requires them for Connect accounts

## Troubleshooting

| Error code | HTTP | Cause | Fix |
|---|---|---|---|
| `CONNECT_NOT_CONFIGURED` | 400 | No Stripe account attached to this app | Run Step 1 |
| `CONNECT_NOT_READY` | 400 | `charges_enabled` is false on the Stripe account | Finish Stripe onboarding; re-check Step 2 |
| `PLAN_NOT_FOUND` | 404 | Bad `planId`, wrong app, or the plan is `active: false` | Re-list plans and check the UUID |
| `PRODUCT_NOT_FOUND` | 404 | Same, for products | — |
| `USER_NOT_FOUND` | 404 | No `app_users` row for the token's user id | The caller must be a real Butterbase-Auth user of *this* app |
| `403 Not authorized` | 403 | Non-owner calling a developer endpoint | Use the app owner's credentials |
| `401` on `subscribe`/`purchase`/`orders` | 401 | Sent a token that isn't an end-user app JWT or a platform token | See Step 6 |
| Nothing activates after payment | — | You granted access from the redirect instead of the recorded state, or (self-hosted) the webhook isn't wired | Re-read `GET /billing/subscription` or the order; self-hosted, check Step 7 and Stripe's delivery log |

## Endpoint reference

**Developer endpoints — platform auth, owner only:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/{app_id}/billing/connect/onboard` | Create/refresh the Stripe Connect account link |
| GET | `/v1/{app_id}/billing/connect/status` | Onboarding + charges + payouts status |
| POST | `/v1/{app_id}/billing/plans` | Create a subscription plan |
| PUT | `/v1/{app_id}/billing/plans/{plan_id}` | Update a plan |
| POST | `/v1/{app_id}/billing/products` | Create a product |
| PUT | `/v1/{app_id}/billing/products/{product_id}` | Update a product |

**Public:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/{app_id}/billing/plans` | Plan catalog |
| GET | `/v1/{app_id}/billing/products` | Product catalog |

**End-user endpoints — app JWT:**

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/{app_id}/billing/subscribe` | Start a subscription checkout |
| GET | `/v1/{app_id}/billing/subscription` | Current subscription |
| POST | `/v1/{app_id}/billing/cancel` | Cancel at period end |
| POST | `/v1/{app_id}/billing/purchase` | Buy a product |
| GET | `/v1/{app_id}/billing/orders` | Order history |
| GET | `/v1/{app_id}/billing/orders/{order_id}` | Single order |

## Data model

| Table | Holds |
|-------|-------|
| `app_plans` | Your subscription plans (`name`, `price_cents`, `interval`, `features`, `active`) |
| `app_products` | Your one-time products (`name`, `description`, `price_cents`, `currency`, `metadata`, `active`) |
| `app_subscriptions` | One row per user per subscription (`status`, period bounds, `cancel_at_period_end`) |
| `app_orders` | One row per purchase attempt (`amount_cents`, `platform_fee_cents`, `status`, `refunded_at`) |

These live in your app's runtime database, so functions and RLS policies can read them directly.

## Not using Connect?

You can skip all of this and call Stripe (or any other processor) yourself from a [serverless function](/core-concepts/functions/), storing purchase state in your own tables. You lose the hosted webhook handling and the built-in subscription model, and you take on PCI and key management. The [Monetization guide](/guides/monetization/) has a compact end-to-end walkthrough of the Connect path.
