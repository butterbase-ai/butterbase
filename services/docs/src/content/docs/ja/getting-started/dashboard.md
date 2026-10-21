---
title: ダッシュボード
description: Webの管理画面からButterbaseアプリを設定・管理する。
---

[dashboard.butterbase.ai](https://dashboard.butterbase.ai)では、バックエンドの各機能を画面から管理できます。

<span id="platform-pages"></span>

## プラットフォームの画面

| 画面 | 用途 |
|------|-------------|
| **Apps** | バックエンドアプリの一覧、作成、管理 |
| **API Keys** | プログラムから使う `bb_sk_` APIキーの生成・管理 |
| **Billing** | プラン、使用量、アップグレードの確認 |
| **Settings** | アカウント設定と開発者モードの切り替え |
| **Templates** | 公開テンプレートを探し、自分の新しいアプリへ複製 |

Apps画面の「Clone template」では、複製元の `app_id` を指定して直接複製できます。

<span id="app-management"></span>

## アプリの管理

アプリを選ぶと、次の項目を使えます。

| 項目 | 用途 |
|---------|-------------|
| **Overview** | アプリID、APIのベースURL、開始手順 |
| **Schema** | テーブル、列、型、制約を画面から確認・変更 |
| **Data** | テーブルの行の確認・追加・編集・削除 |
| **Users** | 利用者のアカウント、プロフィール、新規登録の管理 |
| **OAuth** | Google、GitHub、Discordなどのログイン設定 |
| **RLS** | テーブルの行レベルセキュリティ方針の確認・管理 |
| **Functions** | サーバーレス関数のデプロイ・管理、ログと指標の確認 |
| **Deployments** | フロントエンドの配信履歴と稼働中デプロイの管理 |
| **Realtime** | テーブルのWebSocket通知の設定 |
| **AI** | AIモデルゲートウェイの設定と使用量の確認 |
| **Storage** | アップロード済みファイル、メタデータ、保存領域の管理 |
| **Monetization** | Stripe Connect、定期プラン、商品の管理 |
| **Audit** | ログイン、登録、パスワード再設定などの認証記録 |
| **App Settings** | CORS、JWTの有効期間、アプリ全体の設定 |

<span id="developer-mode"></span>

## 開発者モード

Settingsの開発者モードを有効にすると、Apps画面とアプリ管理の全機能を使えます。無効にすると、課金とアカウント設定を中心とした簡潔な画面になります。

<span id="connecting-to-the-docs"></span>

## 文書を開く

サイドバーの **Documentation** または [docs.butterbase.ai](https://docs.butterbase.ai/ja/) から文書を開けます。
