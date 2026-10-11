<p align="center"><img src=".github/assets/logo.png" alt="Butterbase" width="420" /></p>

# Butterbase

[English](./README.md) · 日本語

Butterbaseは、AIを使うアプリのためのオープンソースのバックエンドです。Apache-2.0で公開され、Docker Composeでセルフホストできます。アプリごとに独立したPostgresデータベースを用意し、認証、ファイル保存、関数、リアルタイム通知、AIゲートウェイ、RAGを提供します。組み込みのMCPサーバーを通じて、AIエージェントからバックエンドを操作できます。

[公式サイト](https://butterbase.ai) · [Discord](https://discord.gg/Aq7q5mqbrt) · [LinkedIn](https://www.linkedin.com/company/butterbase/) · [導入](./SETUP.ja.md) · [ドキュメント](./docs) · [開発予定](./ROADMAP.ja.md) · [サンプル](./Examples) · [貢献](./CONTRIBUTING.ja.md)

## 主な機能

| 分野 | 機能 |
|---|---|
| データ | アプリ別Postgres、宣言的スキーマ、マイグレーション、自動生成REST API、行レベルセキュリティ（RLS） |
| KV | リージョン別のキーと値の保存、TTL、使用量制限、監査記録、公開ルール。v0.2.0で追加 |
| ファイル | S3/R2、署名付きURL、アクセス制御、非同期インデックス |
| 関数 | Deno上で実行するTypeScriptのサーバーレス関数 |
| Durable Objects | チャットルーム、ゲーム、レート制限、長時間エージェントなどのキー別状態管理 |
| リアルタイム | WebSocketによるテーブル変更の購読とプレゼンス |
| フロントエンド | ZIPまたはソースからの静的サイト・SPA配信、独自ドメイン、Next.js / Remix / AstroのEdge SSR |
| エージェント | グラフで定義する複数ステップのLLM処理、チェックポイント、関数・MCPツール、人による承認待ち。`Examples/agents/` に例を収録 |
| AI | チャット、埋め込み、モデル一覧を扱う共通ゲートウェイ。ルーターは差し替え可能 |
| RAG | コレクション、文書取り込み、意味検索、検索結果を使った回答生成 |
| 外部連携 | Composio経由のサードパーティーツール |
| 認証 | メール、Google / GitHub / Apple / XなどのOAuth、JWT設定、ログイン後フック、サービスキー |
| 運用 | 監査ログ、アプリイベントのWebhook、元リージョンのレプリカを保持するアプリ移動 |
| MCP・プラグイン | HTTPの `/mcp` と `npx @butterbase/mcp` のstdio。Claude Codeプラグインは39スキルと34コマンドを収録 |

各アプリのデータは通常のPostgresに保存されます。独自データストアへの移行を前提とせず、スキーマ、RLS、REST APIを使えます。[マネージド版](https://butterbase.ai)には無料枠があり、同じデータプレーンを複数リージョンで提供します。

## セルフホストで始める

Docker、Node.js 22以上、npmが必要です。プラグインは [butterbase-skills](https://github.com/butterbase-ai/butterbase-skills) のGitサブモジュールなので、再帰的に取得します。

```bash
git clone --recurse-submodules https://github.com/butterbase-ai/butterbase.git
cd butterbase
npm ci
cp .env.example .env
docker compose -f docker-compose.local.yml up -d
```

初回はイメージのビルドに数分かかります。コンテナ起動だけではDBスキーマは適用されません。[日本語の導入手順](./SETUP.ja.md)に従って、マイグレーションと開発ユーザーの登録を行ってください。再帰取得を省いた場合は `git submodule update --init --recursive` を実行します。毎回取得する設定は `git config --global submodule.recurse true` です。

ローカルAPIは `http://localhost:4000`、MCPは `/mcp`、Denoは `:7133`、ドキュメントは `:4321` です。既定のローカル構成は `AUTH_ENABLED=false` なので、APIをインターネットに公開しないでください。

## 完成したアプリをテンプレートから使う

[`templates/`](./templates)にはスキーマ、RLS、関数、認証設定、React画面を備えたアプリがあります。`butterbase clone <app_id> <name>` はマネージド版のアカウントが必要な操作です。ライブのバックエンドを、自分専用のDB・URL・APIキーを持つ新しいアプリへ複製します。セルフホストでは、各テンプレートの `backend/` を自分の環境へ手動で反映します。

**[butterbaseCRM](./templates/butterbaseCRM)** は、創業者向けのCRMです。企業、人物、商談のカンバン、会議、メモ、活動履歴に加え、Gmail・Google Calendar同期、情報補完、メールキャンペーン、X / LinkedIn / Reddit / TikTokへの投稿、承認後に操作するAIエージェントを備えます。主要な顧客情報はアプリ間で共有するSubstrateに保存されます。29テーブル、56関数、17テーブルのリアルタイム通知、Google OAuthとメール認証、全テーブルのRLSを収録しています。

`butterbase clone app_44zjayftl7b3 butterbaseCRM` の後、`frontend/.env.example` を `frontend/.env.local` にコピーしてAPP_IDを設定し、`frontend` で `npm install && npm run dev` を実行します。[詳細な導入](./templates/butterbaseCRM/QUICKSTART.md)を参照してください。

**[butterSupport](./templates/butterSupport)** は、ヘルプ文書と実際の製品データを使うAIサポートです。チケット別のDurable Objectが決済失敗や認証エラーなどを調べ、顧客に送る返信を創業者の承認待ちにします。埋め込みウィジェットと運営画面を備え、ヘルプセンターURLだけで始める構成と、製品を連携して対応案を出す構成を選べます。20テーブル、30関数、2つのDurable Object、RAG、HMAC署名のユーザー識別、Composio経由のSlack・Gmailへの引き継ぎを収録しています。

`butterbase clone app_0ycj4ad7odud my-support` を実行し、新しいサブドメインでメールリンク認証後にヘルプセンターURLを設定します。製品のHTMLへ埋め込みコードを追加してください。[詳細な導入](./templates/butterSupport/README.md)を参照してください。

## OSSとマネージド版の範囲

このリポジトリは、セルフホストに必要な実行基盤であるデータプレーンを公開しています。マネージド版の複数リージョンの制御、課金、リース方式の使用量制限、AIの上流プロバイダー用アダプター、利用者・管理者ダッシュボードは非公開のクラウド用リポジトリにあります。

OSSの既定構成では課金は何もしないプロバイダー、使用量制限は無制限です。AIゲートウェイは上流アダプターなしではプロバイダーへ通信しません。`packages/shared` の `BillingProvider`、`QuotaEnforcer`、`RouterAdapter` を使って自分の実装を接続できます。変更範囲は [貢献ルール](./CONTRIBUTING.ja.md)で確認してください。

## 構成とコードの場所

アプリ、CLI、MCPクライアントはREST・WebSocket・MCPでFastifyのControl APIへ接続します。Control APIはPostgres、S3/R2、Redis、Deno、Pythonのエージェント実行環境を使い、Cloudflareのビルド・配信Workerと連携します。

| 場所 | 役割 |
|---|---|
| `db/control-plane/` | ユーザー、アプリ、課金、監査などのプラットフォーム情報 |
| `db/runtime-plane/` | KV公開ルール、リアルタイムチャンネル、セッションなどの実行時情報 |
| `db/data-plane/` | アプリごとに分離したデータとRLS |
| `services/control-api` | 公開APIの入口。`/mcp` にMCPサーバーを組み込む |
| `services/mcp-server` | MCPツール。stdioの `butterbase-mcp` としても利用可能 |
| `services/deno-runtime`・`agent-runtime` | ユーザー関数と長時間エージェントの実行 |
| `services/build-runner`・`do-invoker` | ソースのビルド、外部サービスからDurable Objectsへの呼び出し |
| `services/storage-indexer`・`docs` | アップロードの非同期インデックス、Astroの公開文書 |
| `packages/sdk`・`cli` | ブラウザー・サーバー共通のTypeScript SDK、CLI |
| `packages/plugin`・`shared` | Claude Codeプラグイン、共通型・定数・差し替えインターフェース |
| `packages/static-frontend-worker` | アプリ別静的配信Worker。SPAフォールバックと `_redirects` に対応 |
| `dispatch-worker/`・`bb-placeholder/`・`infra/` | サブドメイン配信、未設定の配信先、PgBouncer・Traefik設定 |
| `Examples/`・`templates/` | 小さなtodo・買い物リスト・エージェント例、完成アプリ |

## 開発状況と参加方法

公開履歴のv0.3.0（2026-06-08）ではエージェント機能を追加し、v0.2.0ではSDK / REST / CLI / MCPから使えるKVを追加しました。データプレーンはマネージド版で運用されていますが、OSS配布は開発初期です。セルフホストでの問題は [GitHub Issues](https://github.com/butterbase-ai/butterbase/issues)へ報告してください。[変更履歴](./CHANGELOG.md)と [開発予定](./ROADMAP.ja.md)も参照できます。

交流は [Discord](https://discord.gg/Aq7q5mqbrt)、製品の告知は [LinkedIn](https://www.linkedin.com/company/butterbase/)、直接の連絡は [yuki@butterbase.ai](mailto:yuki@butterbase.ai) へお願いします。脆弱性は公開Issueに書かず、[セキュリティ方針](./SECURITY.ja.md)に従って `security@butterbase.ai` へ非公開で報告してください。

## ライセンス

[Apache-2.0](./LICENSE)。Copyright 2026 NetGPT Inc. ライセンス本文は英語の `LICENSE` が正式な文書です。[貢献者一覧](https://github.com/butterbase-ai/butterbase/graphs/contributors)を確認できます。
