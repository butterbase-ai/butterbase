# バックエンド — 実環境のミラー

[English](README.md) | 日本語

このディレクトリは、Butterbaseアプリ`app_44zjayftl7b3`の状態を読むためのミラーです。正本はプラットフォームにあります。ローカルファイルを編集しても実アプリは変わりません。変更はMCP・CLI・管理画面から行い、`./sync.sh`でミラーを更新します。

## ファイル構成

```
backend/
├── README.md                       # this file
├── sync.sh                         # pulls live state into the files below
├── schema.json                     # 29 tables + indexes (manage_schema get)
├── auth/
│   └── config.json                 # JWT TTLs, OAuth providers, password rules
├── rls/
│   ├── policies.sql                # CREATE POLICY statements (auto-generated from policies.json)
│   └── policies.json               # raw output of manage_rls list / butterbase rls list
├── functions/                      # one folder per deployed function (56 today)
│   └── <name>/
│       ├── handler.ts              # the deployed source
│       └── function.json           # triggers, timeoutMs, memoryLimitMb, agent_tool flags
├── integrations/
│   └── integrations.json           # configured Composio toolkits
├── storage/
│   └── objects.json                # storage object listing
├── realtime.json                   # which tables broadcast row changes
└── ai.json                         # default model + allowed models
```

## 実行環境

| 機能 | 接続先・構成 |
|---|---|
| DB | Butterbase上のPostgres。原文時点で29テーブル、ポリシーの記録は19テーブル |
| API | `https://api.butterbase.ai/v1/app_44zjayftl7b3/<table>`。画面からSDKで接続 |
| 認証 | `/auth/app_44zjayftl7b3/...`。メール・パスワードとGoogle OAuth |
| ストレージ | `/storage/app_44zjayftl7b3/...`の署名付きURL。原文の上限は1ファイル10 MB |
| Realtime | `wss://api.butterbase.ai/v1/app_44zjayftl7b3/realtime?token=<jwt>`。17テーブル |
| 関数 | `/v1/app_44zjayftl7b3/fn/<name>`。原文時点で56のHTTP・cron関数 |
| 外部連携 | Composio。各利用者が自分のアカウントを接続 |
| AI | `/v1/app_44zjayftl7b3/chat/completions`。原文のモデルは`anthropic/claude-haiku-4.5` |
| substrate | オーナーのsubstrateへ接続。関数へ`ctx.substrate`を注入 |

テーブル数や関数数は原文のスナップショットです。現在の設定は各JSONと実環境を確認してください。

- [データ構造・RLS](../docs/ja/backend-data.md)
- [関数・認証・スキーマの注意](../docs/ja/backend-functions.md)

## 同期

```sh
cd backend
./sync.sh
```

実環境から取得してファイルを上書きします。コミット前に差分を確認してください。

## 実環境のURL

- [アプリ](https://butterbase-crm.butterbase.dev)
- [API](https://api.butterbase.ai/v1/app_44zjayftl7b3)
- Google OAuthの登録先：`https://api.butterbase.ai/auth/app_44zjayftl7b3/oauth/google/callback`
- 関数：`https://api.butterbase.ai/v1/app_44zjayftl7b3/fn/{name}`
