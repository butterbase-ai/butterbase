---
title: 収益化
description: Stripe Connectでユーザーにサブスクリプションや商品を販売します。
---

組み込みStripe Connectで、エンドユーザー向けサブスクリプションと単発商品を販売できます。自分のButterbase契約とは別で、作った製品の収益化に使います。

:::note
このガイドはAPIの概要です。登録、Webhook、アクセス制御、テスト、本番移行、問題の対処は[ユーザーへの課金](/ja/core-concepts/billing/)を参照してください。
:::

<span id="how-it-works"></span>

## 仕組み

1. アプリのStripe Connectアカウントを登録
2. 価格付きのプランか商品を定義
3. プラットフォームのCheckoutでユーザーが契約・購入

<span id="setting-up-stripe-connect"></span>

## Connectの設定

<span id="step-1-onboard-your-connect-account"></span>

### 手順1：登録

```
POST /v1/{app_id}/billing/connect/onboard
```

accountIdとonboardingUrlを返します。Stripeで設定を完了します。

<span id="step-2-check-onboarding-status"></span>

### 手順2：状態確認

```
GET /v1/{app_id}/billing/connect/status
```

登録完了と入金準備の状態を返します。

<span id="subscriptions"></span>

## サブスクリプション

<span id="developer-endpoints-platform-auth"></span>

### 開発者向け（プラットフォーム認証）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/plans | プラン作成 |
| GET | /v1/\{app_id}/billing/plans | 公開プラン一覧 |
| PUT | /v1/\{app_id}/billing/plans/\{plan_id} | プラン更新 |

**プラン作成：**

```json
POST /v1/{app_id}/billing/plans

{
  "name": "Pro Plan",
  "priceCents": 999,
  "interval": "month",
  "features": ["Unlimited projects", "Priority support", "Custom domain"]
}
```

<span id="end-user-endpoints-app-jwt"></span>

### ユーザー向け（アプリJWT）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/subscribe | 契約開始 |
| GET | /v1/\{app_id}/billing/subscription | 現在の契約 |
| POST | /v1/\{app_id}/billing/cancel | 期間終了時に解約 |

**契約開始：**

```json
POST /v1/{app_id}/billing/subscribe

{
  "planId": "uuid-of-plan",
  "successUrl": "https://yourapp.com/billing/success",
  "cancelUrl": "https://yourapp.com/billing/cancel"
}
```

支払い用のStripe Checkout URLを返します。

<span id="one-time-purchases"></span>

## 単発購入

デジタル商品、物品、一度限りの利用権などを販売します。

<span id="developer-endpoints"></span>

### 開発者向け

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/products | 商品作成 |
| GET | /v1/\{app_id}/billing/products | 公開商品一覧 |
| PUT | /v1/\{app_id}/billing/products/\{product_id} | 商品更新 |

**商品作成：**

```json
POST /v1/{app_id}/billing/products

{
  "name": "Premium Template Pack",
  "priceCents": 2999,
  "description": "50+ premium UI templates",
  "metadata": { "category": "templates" }
}
```

<span id="end-user-endpoints"></span>

### ユーザー向け

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/purchase | 商品購入 |
| GET | /v1/\{app_id}/billing/orders | 注文一覧 |
| GET | /v1/\{app_id}/billing/orders/{order_id} | 注文詳細 |

<span id="order-statuses"></span>

### 注文状態

| 状態 | 意味 |
|--------|---------|
| `pending` | Checkout作成済み、未決済 |
| `paid` | 支払い成功 |
| `failed` | 支払い失敗 |
| `refunded` | 返金済み |

<span id="webhooks"></span>

## Webhook

StripeはPOST /webhooks/stripe/connectへ通知します。Cloudでは設定済みです。セルフホストではStripeのプラットフォームアカウントに登録し、**接続アカウントのイベント**を有効にして、Control APIにSTRIPE_CONNECT_WEBHOOK_SECRETを設定します。

処理するイベント：
- checkout.session.completed（契約と購入）
- `customer.subscription.updated` / `deleted`
- `invoice.payment_succeeded` / `failed`
- `payment_intent.payment_failed`
- `charge.refunded`

<span id="example-flow-subscriptions"></span>

## 契約の流れ

1. 開発者がPOST /v1/{app_id}/billing/plansで作成。
2. ユーザーがPOST /v1/{app_id}/billing/subscribeで開始。
3. Stripe Checkoutで支払い。
4. Webhookで契約を有効化。
5. GET /v1/{app_id}/billing/subscriptionで確認。

<span id="alternative-approach"></span>

## 別の方法

Connectが不要なら、[関数](/ja/core-concepts/functions)でStripeを直接使ってCheckoutを作り、購入状態をアプリのテーブルへ保存できます。
