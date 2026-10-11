---
title: プランと使用量
description: Butterbaseの使用量、AIクレジット、追加購入、支出上限、制限到達時の動作。
---

このページは、バックエンドの運用に対して**Butterbaseへ支払う料金**の説明です。

**自分のエンドユーザーへの課金**は[ユーザーへの課金](/ja/core-concepts/billing/)を参照してください。

<span id="plans"></span>

## プラン

4つのプランがあり、上位ほど下位の機能に追加機能が加わります。

| | |
|---|---|
| **Playground** | 無料。動作を試すためのプランで、カード登録は不要。 |
| **Launch** | Playgroundの全機能と、実ユーザー向け公開に必要な容量、[カスタムドメイン](/ja/core-concepts/custom-domains/)、[プレビューデプロイ](/ja/core-concepts/preview-deployments/)。 |
| **Certified** | Launchの全機能、成長に必要な容量、より多くのAI利用枠、優先サポート。 |
| **Enterprise** | Certifiedの全機能、SSO、SOC 2報告書、HIPAA追加機能、稼働時間保証、専任窓口。価格は相談。 |

課金単位はアプリではなく**組織**です。全アカウントはPlaygroundから始まります。

価格と利用枠は変更されるため、このページには転記しません。最新値は次で確認できます。

- **[butterbase.ai/pricing](https://butterbase.ai/pricing)** — プランの比較
- **[ダッシュボードのBilling](https://dashboard.butterbase.ai/billing)** — 自分の組織のプランと、各上限に対する現在の使用量

```bash
butterbase billing status
```

Playgroundのプロジェクトは活動が1週間ないと一時停止します。データは削除せず、戻ったときにダッシュボードから再開できます。

<span id="usage-meters"></span>

## 使用量の計測

| メーター | 計測対象 |
|-------|-----------------|
| `ai_credits` | AIモデルの利用費用（ドル） |
| `storage_bytes` | 組織内の全アプリの合計ファイル容量 |
| `lambda_invocations` | 関数の合計実行数 |
| `bandwidth_bytes` | 送信したデータ量 |

<span id="credits-top-ups-and-spending-caps"></span>

## クレジット・追加購入・支出上限

組織ごとのAIクレジットを、次の順序で消費します。

1. **月次利用枠** — プランごとのクレジット。サブスクリプション請求の支払い成功時に補充。
2. **追加購入残高** — 事前購入する従量制クレジット。有効期限なし。

両方がなくなるとAI呼び出しを停止します。追加購入かアップグレードで再開でき、裏で料金が増え続けることはありません。

**クレジットの追加購入：**

```
POST /dashboard/billing/topup
{ "amount": 25 }
```

```bash
butterbase billing topup 25
```

**支出上限**は組織ごとのAI支出の最大額です。ダッシュボードのBillingで確認・変更できます。

```bash
butterbase billing cap get
butterbase billing cap raise --raise-by 50
```

**自動補充**を設定すると、残高が指定値を下回ったときに追加購入します。Billingで設定できます。

<span id="checking-your-usage"></span>

## 使用量の確認

```
GET /dashboard/billing
```

現在のプラン、制限、使用率、クレジット残高、支出上限を返します。

```
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_credits
```

指定期間の日次使用量を返します。

```bash
butterbase billing status
butterbase billing usage --start 2026-01-01 --end 2026-01-31 --meter ai_credits
```

<span id="upgrading-your-plan"></span>

## プランのアップグレード

```json
POST /dashboard/billing/checkout
{ "planId": "<plan-id>" }
```

Stripe Checkoutの`url`を返します。支払い成功後、制限はすぐに更新されます。

<span id="managing-your-subscription"></span>

## サブスクリプションの管理

```
POST /dashboard/billing/portal
```

StripeのセルフサービスポータルURLを返します。支払方法の更新、請求書の取得、解約ができます。

```bash
butterbase billing portal
```

<span id="what-happens-when-you-exceed-a-limit"></span>

## 上限に達したとき

**無料プラン：** 組織をsoft-lockします。読み取りは可能で、使用量の減少かアップグレードまで書き込みを止めます。

**有料プラン：** AI残高がなくなると、追加購入かアップグレードまでAI呼び出しを止めます。ストレージなどの制限はプラン上限で判定します。支払い失敗では猶予期間を設け、期限を過ぎると組織を停止します。

<span id="account-statuses"></span>

## アカウントの状態

| ステータス | 意味 |
|--------|---------|
| `active` | 通常運用 |
| `soft_locked` | 無料プランの上限超過 |
| `suspended` | 支払い失敗後の猶予期間が終了 |

---
