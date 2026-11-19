# butterbaseCRM

[English](README.md) | 日本語

創業者向けのOSS CRMです。会社・連絡先・商談・会議を、エージェントから読めるButterbase substrateの共有メモリへ保存します。ワークスペースのAIエージェント、外部のClaude、アプリの関数が同じ事業の情報を参照できます。

[Butterbase](https://butterbase.ai)上で動作し、Apache-2.0で公開しています。

## 主な機能

- 会社・連絡先：検索、プロフィール、関連する人・商談・会議・メモ・活動履歴。People APIで取得できるロゴや所在地、プロフィール項目を補完します。
- 商談：カスタマイズできるステージのカンバン。メモ・ファイル・会議・連絡先を関連づけます。
- Gmail・カレンダー：メールと予定を取り込み、通信相手を連絡先・会社へ登録します。
- メールキャンペーン：連絡先リストへの配信と、配信・開封状態の確認。
- SNS投稿：CRM内で下書きと予約を扱い、関連する連絡先・商談へ結びつけます。対応SNSは接続設定と画面を確認してください。現行UIでInstagram・TikTokは準備中です。
- AIエージェント：パイプラインの質問、会社の要約、フォローアップ・商談作成・メモの提案。書き込み前に利用者が確認・承認します。
- チーム：メンバーを招待し、ワークスペース単位のRLSでアクセスを制御します。

butterSupportと同じsubstrateを使うと、両アプリで顧客の識別情報を共有できます。

## 構成

| 要素 | 内容 |
|---|---|
| substrate | 会社・連絡先・商談・会議・参加者を`ent_*`として保存し、エージェントから操作 |
| Postgres | 原文時点で29テーブル。ワークスペース、招待、活動、添付、保存ビュー、キャンペーン、SNS、エージェントなど |
| 関数 | 原文時点で55以上。同期、文字起こし、情報補完、提案、リード検索、配信、SNS、substrateの窓口、cron |
| 外部連携 | Composio経由でGoogleやSNSへ接続。利用者ごとに自分のアカウントを接続 |
| Realtime | 原文時点で17テーブルのINSERT/UPDATE/DELETEをWebSocketで配信 |
| 画面 | Vite・React・Tailwind・shadcn/ui |
| 認証 | メール・パスワード、Google OAuth、`app_allowlist`、管理者が発行する招待 |
| RLS | ワークスペースのメンバー資格で制御。ミラー上にポリシーがないテーブルの注意は[バックエンド](backend/README.ja.md)を参照 |

## リポジトリ構成

```
backend/     read-only mirror of the live Butterbase app (schema, RLS, functions, configs)
             — the platform is the source of truth; `./sync.sh` refreshes this folder
frontend/    Vite + React single-page app
docs/        design specs, build log, plans, known limitations
dev/         local helper scripts
QUICKSTART.md  step-by-step setup — start here
```

## クイックスタート

詳しくは[日本語クイックスタート](QUICKSTART.ja.md)を参照してください。

```bash
# 1. Clone the Butterbase app so you own your own backend
butterbase clone <source_app_id> butterbaseCRM
cd butterbaseCRM

# 2. Configure secrets
cp .env.example .env                       # fill in your BUTTERBASE_API_KEY / APP_ID
cp frontend/.env.example frontend/.env.local

# 3. Run the frontend
cd frontend && npm install && npm run dev
```

ここで「複製」はButterbaseアプリの複製です。`manage_app`の`clone`または`butterbase clone`で、新しいDB・URL・APIキーを持つアプリを自分のアカウントへ作ります。Gitのcloneだけでは、フロントエンドとバックエンドの読み取り用ミラーだけを取得します。

## 設定・日本語表示

シークレットは環境変数から読みます。Gitで除外した`.env`・`.env.local`へ、自分の値を設定してください。`bb_sk_*`サービスキーやOAuthのクライアントシークレットをコミットしないでください。

ログイン画面と上部の言語欄で「日本語」を選びます。初期値は英語で、選択をブラウザーに保存します。言語を切り替えても入力途中の値は保持します。顧客の名前・メモ・API識別子・送信値は翻訳しません。

複製ごとに1ワークスペースを想定して開発中です。[TODO](TODO.md)と[既知の制約](docs/known-limitations.md)も確認してください。

Apache-2.0です。[LICENSE](../../LICENSE)を参照してください。
