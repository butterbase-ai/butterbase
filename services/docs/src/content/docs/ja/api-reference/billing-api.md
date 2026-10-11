---
title: 課金API
description: 課金、使用量、Stripe Connectのエンドポイント一覧。
sidebar:
  order: 7
---

<span id="platform-billing"></span>

## プラットフォームの課金

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /dashboard/billing | 現在のプラン、使用量、上限 |
| GET | /dashboard/usage | 日ごとの使用履歴 |
| POST | /dashboard/billing/checkout | アップグレードの決済を開始 |
| POST | /dashboard/billing/portal | 課金ポータルを開く |

<span id="usage-history"></span>

### 使用履歴

```
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_tokens
```

| パラメーター | 説明 |
|-----------|-------------|
| `startDate` | 範囲の開始日（ISO日付） |
| `endDate` | 範囲の終了日（ISO日付） |
| `meterType` | フィルター：`storage_bytes`、`ai_tokens`、`lambda_invocations`、`bandwidth_bytes` |

<span id="stripe-connect-monetization"></span>

## Stripe Connect（収益化）

<span id="developer-endpoints-platform-auth"></span>

### 開発者向けエンドポイント（プラットフォーム認証）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/connect/onboard | Connectの登録を開始 |
| GET | /v1/\{app_id}/billing/connect/status | 登録状態を確認 |

<span id="subscription-plans"></span>

### サブスクリプションプラン

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/plans | プランを作成 |
| GET | /v1/\{app_id}/billing/plans | プランを一覧取得 |
| PUT | /v1/\{app_id}/billing/plans/\{plan_id} | プランを更新 |

**作成：**

```json
{
  "name": "Pro Plan",
  "priceCents": 999,
  "interval": "month",
  "features": ["Feature 1", "Feature 2"]
}
```

<span id="products-one-time-purchases"></span>

### 商品（単発購入）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/products | 商品を作成 |
| GET | /v1/\{app_id}/billing/products | 商品を一覧取得 |
| PUT | /v1/\{app_id}/billing/products/\{product_id} | 商品を更新 |

**作成：**

```json
{
  "name": "Premium Template",
  "priceCents": 2999,
  "description": "50+ templates",
  "metadata": { "category": "templates" }
}
```

<span id="end-user-endpoints-app-jwt"></span>

### エンドユーザー向けエンドポイント（アプリJWT）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/billing/subscribe | サブスクリプションを開始 |
| GET | /v1/\{app_id}/billing/subscription | 現在のサブスクリプション |
| POST | /v1/\{app_id}/billing/cancel | 期間終了時の解約を設定 |
| POST | /v1/\{app_id}/billing/purchase | 商品を購入 |
| GET | /v1/\{app_id}/billing/orders | 注文を一覧取得 |
| GET | /v1/\{app_id}/billing/orders/{order_id} | 注文の詳細を取得 |

<span id="webhooks"></span>

### Webhook

```
POST /webhooks/stripe/connect
```

Control APIの環境変数に`STRIPE_CONNECT_WEBHOOK_SECRET`を設定します。

処理するイベント：`checkout.session.completed`、`customer.subscription.updated`、`customer.subscription.deleted`、`invoice.payment_succeeded`、`invoice.payment_failed`、`payment_intent.payment_failed`、`charge.refunded`
