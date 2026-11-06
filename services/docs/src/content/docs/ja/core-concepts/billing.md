---
title: アプリのユーザーへの課金
description: Stripe Connectで定期プランと買い切り商品を販売します。プラットフォーム手数料はありません。
---

このページでは、**アプリのエンドユーザーから自分のStripeアカウントへ代金を受け取る方法**を説明します。

Butterbaseから**自分への請求**（プランの利用枠、AIクレジット、支出上限、使用量）は[プランと使用量](/ja/core-concepts/plans-and-usage/)を参照してください。

標準の**Stripe Connect**連携で、定期プランと買い切り商品を販売できます。Stripe用のコード、決済画面、Webhookサーバーを用意する必要はありません。

<span id="what-you-get"></span>

## 利用できる機能

- **自分のStripeアカウントへ入金。** 自分が所有するStripe Expressアカウントを作成し、そのアカウントで決済します。Stripeから銀行へ入金されます。
- **プラットフォーム手数料0%。** `platform_fee_cents`は常に0で、Butterbaseの取り分はありません。Stripeの通常の決済手数料は必要です。
- **Stripeの決済画面。** 購入ごとにStripe Checkout URLを返し、カード情報はStripeが処理します。
- **Webhookを処理。** 開始、更新、失敗、解約、返金の結果をアプリのテーブルへ記録します。
- **データベースの購読・注文モデル。** `app_plans`、`app_products`、`app_subscriptions`、`app_orders`を関数やRLSから参照できます。
- **複数の操作方法。** ダッシュボード、REST、CLI（`butterbase app-billing`）、SDK（`bb.billing.*`）、MCP。

<span id="before-you-begin"></span>

## 事前準備

- [ ] アプリを作成し、**ユーザーがButterbase Authでログイン**できる状態にします。メールのある`app_users`の行が必要です。[認証](/ja/core-concepts/authentication/)を参照してください。
- [ ] Stripeアカウントを用意し、国ごとの本人・銀行確認を完了できることを確認します。
- [ ] 定期**プラン**、買い切り**商品**、または両方を選びます。
- [ ] フロントエンドに`successUrl`と`cancelUrl`を用意します。

<span id="step-1--onboard-your-stripe-connect-account"></span>

## 手順1：Stripe Connectへの登録

アプリ用のStripe Expressアカウントを作成し、Stripeの登録用リンクを取得します。

**ダッシュボード（推奨）：** **App → Monetization → Stripe Connect → Connect with Stripe**を選び、Stripeで登録して戻ります。

**REST API：**

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

**SDK：**

```typescript
const { data } = await bb.billing.connectOnboard();
window.location.href = data.onboardingUrl;
```

:::caution
Connect、プラン、商品の管理は**アプリの所有者だけ**が呼び出せます。他の組織メンバーには`403 Not authorized`を返します。
:::

`onboardingUrl`を開き、事業情報、本人確認、入金先の銀行を登録します。リンクは1回限りで有効期限があるため、必要なら再発行してください。審査に数分以上かかることがあり、国によっては書類審査が終わるまで`payouts_enabled`が有効になりません。

<span id="step-2--confirm-you-can-accept-payments"></span>

## 手順2：決済できる状態の確認

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

| フィールド | trueになると可能なこと |
|-------|------------------------|
| `detailsSubmitted` | Stripeの登録完了 |
| `chargesEnabled` | **決済画面の作成**。無効なら`CONNECT_NOT_READY`で拒否。 |
| `payoutsEnabled` | Stripeから銀行への入金 |

`chargesEnabled`がfalseなら、手順1へ戻ってStripeが要求する登録を完了してください。

<span id="step-3--choose-your-pricing-model"></span>

## 手順3：料金モデルの選択

| 販売するもの | 使用するモデル | 作成するオブジェクト |
|---|---|---|
| 月額・年額の利用権 | **プラン** | `app_plans` → `app_subscriptions` |
| 買い切り（デジタル商品、クレジット、無期限の利用権） | **商品** | `app_products` → `app_orders` |
| 両方 | 両方 | — |

プランと商品は独立しており、それぞれ複数作成できます。

<span id="step-4a--create-subscription-plans"></span>

## 手順4a：定期プランの作成

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

| フィールド | 型 | 補足 |
|-------|------|-------|
| `name` | string, 1–100 chars | Stripe Checkoutの商品名として表示 |
| `priceCents` | integer ≥ 0 | **セント単位**。999は9.99米ドル。定期プランは米ドル建てです。 |
| `interval` | `"month"` \| `"year"` | 既定値は`"month"`。 |
| `features` | string[] | 画面で使う任意の特徴の箇条書き |

作成した行を返します。`id`（UUID）を`subscribe`へ指定します。

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

**プランの変更：**

```json
PUT /v1/{app_id}/billing/plans/{plan_id}
{ "priceCents": 1299, "active": true }
```

`name`、`priceCents`、`features`、`active`を更新できます。`interval`は変更できないため、新しいプランを作成してください。`active: false`で新規受付を停止しても、既存の購読は続きます。

:::note
料金変更は**新しい決済だけ**に適用します。既存の購読者は再契約するまで元の料金です。
:::

<span id="step-4b--create-one-time-products"></span>

## 手順4b：買い切り商品の作成

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

| フィールド | 型 | 補足 |
|-------|------|-------|
| `name` | string, 1–100 chars | 決済画面の商品名 |
| `description` | string, ≤ 500 chars | 任意。決済画面に表示。 |
| `priceCents` | integer ≥ 0 | セント単位 |
| `metadata` | `Record<string,string>` | 注文にも含める独自のキー。商品提供の判断に使えます。 |

通貨の既定値は`usd`です。`PUT /v1/{app_id}/billing/products/{product_id}`で`name`、`description`、`priceCents`、`active`、`metadata`を更新できます。

```bash
butterbase app-billing products create --name "Template Pack" --price-cents 2999
```

<span id="step-5--show-the-catalog-in-your-app"></span>

## 手順5：アプリに一覧を表示

プランと商品の一覧は**公開**APIです。認証なしで、ログイン前の料金ページにも表示できます。

```
GET /v1/{app_id}/billing/plans      → { "plans":   [...] }
GET /v1/{app_id}/billing/products   → { "products": [...] }
```

```typescript
const { data: plans } = await bb.billing.listPlans();
const { data: products } = await bb.billing.listProducts();
```

`active`がfalseの行は表示から除外してください。過去の購読で名前を参照できるよう、無効な行もAPIは返します。

<span id="step-6--send-a-user-to-checkout"></span>

## 手順6：決済画面へ移動

:::danger
`subscribe`と`purchase`は**エンドユーザーとして**呼び出します。Butterbase AuthのアプリJWTを使い、プラットフォームAPIキーは使いません。JWTのユーザーIDへ購読を紐付けます。
:::

**定期プランの購入：**

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

**買い切り商品の購入：**

```json
POST /v1/{app_id}/billing/purchase
Authorization: Bearer {end_user_app_jwt}

{ "productId": "8b21…-uuid", "successUrl": "…", "cancelUrl": "…" }
```

```json
{ "sessionId": "cs_live_…", "url": "https://checkout.stripe.com/…", "orderId": "0c7d…-uuid" }
```

決済画面を開く**前に**`app_orders`へ`pending`の行を保存するため、対応するIDを追跡できます。

次に決済画面へ移動します。

```typescript
const { data, error } = await bb.billing.subscribe({
  planId: plan.id,
  successUrl: `${window.location.origin}/billing/success`,
  cancelUrl: `${window.location.origin}/pricing`,
});
if (error) return showError(error);
window.location.href = data.url;
```

`successUrl`と`cancelUrl`は任意ですが、指定してください。既定値は自分のアプリではなくButterbaseのダッシュボードです。

<span id="step-7--understand-what-happens-after-payment"></span>

## 手順7：決済後の処理

ユーザーが`successUrl`へ戻っただけでは確定しません。Stripeの確認後、ConnectのWebhookが結果をテーブルへ記録します。

| Stripeイベント | Butterbaseの処理 |
|-------|----------------------|
| `checkout.session.completed` | 購読を有効化、または注文を`paid`に変更 |
| `invoice.paid` | 購読期間を更新 |
| `invoice.payment_failed` | 購読を`past_due`に変更 |
| `customer.subscription.updated` | 状態と`cancel_at_period_end`を同期 |
| `customer.subscription.deleted` | 購読を解約済みに変更 |
| `payment_intent.payment_failed` | 注文を`failed`に変更 |
| `charge.refunded` | 注文を`refunded`に変更し、`refunded_at`を記録 |

StripeのイベントIDで重複を防ぐため、再試行でも二重処理しません。

**Butterbase Cloudでは設定は不要です。** Expressアカウントのイベントを自動で受信します。`GET /billing/subscription`や`GET /billing/orders`の状態を読み取ってください。Webhookが後から届くこともあるため、`successUrl`への移動だけで利用権を付与しないでください。

:::note[セルフホストの場合]
自分のControl APIでは、`https://<your-control-api>/webhooks/stripe/connect`をStripeへ登録し、**Listen to events on Connected accounts**を有効にします。`account`のないイベントは処理しません。上記イベントを購読し、署名用シークレットを`STRIPE_CONNECT_WEBHOOK_SECRET`に設定してください。
:::

<span id="step-8--gate-access-on-subscription-status"></span>

## 手順8：購読状態によるアクセス制御

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

購読がなければ`{ "subscription": null }`です。`active`、`trialing`、`past_due`だけを返し、解約済み・期限切れは`null`になります。

```typescript
const { data: sub } = await bb.billing.getSubscription();
const isPro = sub !== null && sub.status === 'active';
```

**UIだけでなくサーバー側で制御してください。** [サーバーレス関数](/ja/core-concepts/functions/)で呼び出し元の`app_subscriptions`を確認してから、有料の処理を行います。

```sql
SELECT 1 FROM app_subscriptions
WHERE app_id = $1 AND user_id = $2
  AND status IN ('active', 'trialing')
  AND current_period_end > now();
```

同じテーブルを[行レベルセキュリティ](/ja/core-concepts/row-level-security/)で参照し、有効な購読のあるユーザーだけに行を公開できます。

<span id="step-9--cancellation"></span>

## 手順9：解約

```
POST /v1/{app_id}/billing/cancel
Authorization: Bearer {end_user_app_jwt}
```

`cancel_at_period_end = true`を設定します。`current_period_end`まで利用でき、その後Stripeの`customer.subscription.deleted`で購読が取得されなくなります。有効な購読がなければ404です。

再開用のエンドポイントはありません。再度購入してください。

<span id="step-10--fulfilling-one-time-purchases"></span>

## 手順10：買い切り商品の提供

```
GET /v1/{app_id}/billing/orders            → { "orders": [...] }
GET /v1/{app_id}/billing/orders/{order_id} → one order
```

いずれもエンドユーザー単位で、自分の注文だけを取得できます。

| 状態 | 意味 |
|--------|---------|
| `pending` | 決済画面を作成済み、支払いは未完了 |
| `paid` | 決済成功。**この状態で商品を提供**。 |
| `failed` | 決済失敗 |
| `refunded` | 返金済み。`refunded_at`を設定。 |

`pending`では提供しないでください。完了画面で`paid`を確認するか、関数内で注文を確認してから提供します。注文の商品の`metadata`で提供内容を判断できます。

<span id="testing-before-you-launch"></span>

## 公開前のテスト

1. Stripeを**テストモード**にし、テスト用の事業情報でConnectの登録を完了します。
2. テスト用のプランと商品を作ります。
3. エンドユーザーとしてログインし、`subscribe`と`purchase`を呼び出します。
4. テストカード`4242 4242 4242 4242`、未来の有効期限、任意のCVCで決済します。失敗例には`4000 0000 0000 0341`を使います。
5. Webhookを確認し、購読が`active`、または注文が`paid`になったことを確認します。
6. 解約と返金も試し、Stripeでの返金後に注文が`refunded`になることを確認します。

<span id="going-live-checklist"></span>

## 本番開始の確認

- [ ] `connect/status`の`chargesEnabled`と`payoutsEnabled`が両方有効
- [ ] 販売しないプランと商品は`active: false`
- [ ] `successUrl`と`cancelUrl`が自分のドメイン
- [ ] サーバー側でアクセスを制御
- [ ] Connectアカウントに必要な利用規約と返金方針を用意

<span id="troubleshooting"></span>

## 問題の解決

| エラーコード | HTTP | 原因 | 対処 |
|---|---|---|---|
| `CONNECT_NOT_CONFIGURED` | 400 | Stripeアカウントが未接続 | 手順1を実行 |
| `CONNECT_NOT_READY` | 400 | Stripeの`charges_enabled`がfalse | 登録を完了し、手順2を再確認 |
| `PLAN_NOT_FOUND` | 404 | planIdが不正、別アプリ、または`active: false` | 一覧とUUIDを確認 |
| `PRODUCT_NOT_FOUND` | 404 | 商品に対する同様の問題 | 商品一覧を確認 |
| `USER_NOT_FOUND` | 404 | トークンのユーザーIDの`app_users`行がない | このアプリのButterbase Authユーザーとして呼び出す |
| `403 Not authorized` | 403 | 所有者以外が開発者用APIを呼び出した | 所有者の認証情報を使う |
| `subscribe`・`purchase`・`orders`の`401` | 401 | エンドユーザーのアプリJWTとして利用できないトークン | 手順6を確認 |
| 決済後に有効にならない | — | 確定前のリダイレクトだけで判断したか、Webhookが未設定 | 購読・注文を再取得。セルフホストでは手順7とStripeの配信ログを確認。 |

<span id="endpoint-reference"></span>

## エンドポイントの一覧

**開発者用：プラットフォーム認証、所有者専用：**

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | `/v1/{app_id}/billing/connect/onboard` | Stripe Connectの登録リンクを作成・更新 |
| GET | `/v1/{app_id}/billing/connect/status` | 登録、決済、入金の状態 |
| POST | `/v1/{app_id}/billing/plans` | 定期プランを作成 |
| PUT | `/v1/{app_id}/billing/plans/{plan_id}` | プランを更新 |
| POST | `/v1/{app_id}/billing/products` | 商品を作成 |
| PUT | `/v1/{app_id}/billing/products/{product_id}` | 商品を更新 |

**公開：**

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | `/v1/{app_id}/billing/plans` | プラン一覧 |
| GET | `/v1/{app_id}/billing/products` | 商品一覧 |

**エンドユーザー用：アプリJWT：**

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | `/v1/{app_id}/billing/subscribe` | 定期プランの決済を開始 |
| GET | `/v1/{app_id}/billing/subscription` | 現在の購読 |
| POST | `/v1/{app_id}/billing/cancel` | 期間終了時に解約 |
| POST | `/v1/{app_id}/billing/purchase` | 商品を購入 |
| GET | `/v1/{app_id}/billing/orders` | 注文履歴 |
| GET | `/v1/{app_id}/billing/orders/{order_id}` | 注文を1件取得 |

<span id="data-model"></span>

## データモデル

| テーブル | 保存内容 |
|-------|-------|
| `app_plans` | 定期プラン（`name`、`price_cents`、`interval`、`features`、`active`） |
| `app_products` | 買い切り商品（`name`、`description`、`price_cents`、`currency`、`metadata`、`active`） |
| `app_subscriptions` | ユーザーの購読ごとの行（`status`、期間、`cancel_at_period_end`） |
| `app_orders` | 購入の試行ごとの行（`amount_cents`、`platform_fee_cents`、`status`、`refunded_at`） |

アプリのランタイムデータベースにあり、関数とRLSから直接参照できます。

<span id="not-using-connect"></span>

## Connectを使わない場合

[サーバーレス関数](/ja/core-concepts/functions/)からStripeなどを直接呼び出し、自分のテーブルに状態を保存することもできます。この場合、Webhook、購読モデル、PCI対応、キー管理は自分で実装・管理します。[収益化ガイド](/ja/guides/monetization/)にConnectの一連の手順があります。
