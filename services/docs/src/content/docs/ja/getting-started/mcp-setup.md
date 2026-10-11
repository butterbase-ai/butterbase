---
title: MCPの接続
description: Model Context ProtocolでAIアシスタントをButterbaseへ接続する。
---

MCPでAIアシスタントを接続すると、アプリ作成、スキーマ変更、認証設定、ファイル管理、関数のデプロイなどを構造化したツールで操作できます。

<span id="what-is-mcp"></span>

## MCPとは

**Model Context Protocol（MCP）** は、AIアシスタントを外部ツールやデータへ接続する標準です。Butterbaseを接続すると、アプリ作成、リージョン選択、スキーマ変更、認証、関数配信などのツールと、開始手順のプロンプトを使えます。

<span id="setting-up-the-mcp-connection"></span>

## MCPを接続する

<span id="option-1-claude-code-plugin-recommended"></span>

### 方法1：Claude Codeプラグイン（推奨）

Claude Code用のButterbase Skillsをインストールすると、MCPサーバーが自動設定され、開発を案内するスキルを使えます。

```bash
# Add the marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase-skills@butterbase-skills
```

APIキーを設定します。

```bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

プラグインには次の機能があります。
- **MCPの自動設定**：約40のツールと1つのプロンプトをすぐ使えます。
- **39スキルと34コマンド**：企画から計画、実装、配信を案内する `/butterbase-skills:journey` に加え、`/butterbase-skills:build-app`、`/butterbase-skills:schema`、`/butterbase-skills:deploy`、`/butterbase-skills:debug-rls`、`/butterbase-skills:function` などを使えます。
- **常時参照する情報**：環境変数、作業手順、実装パターンを提供します。

<span id="option-2-cli-setup"></span>

### 方法2：CLIから設定する

Butterbase CLIをインストール済みなら、次を実行します。

```bash
butterbase plugin setup
```

プロジェクトにMCP接続設定の `.mcp.json` を生成します。

<span id="option-3-manual-configuration"></span>

### 方法3：手動で設定する

`.mcp.json` またはエディターのMCP設定に追加します。

```json
{
  "mcpServers": {
    "butterbase": {
      "url": "https://api.butterbase.ai/mcp",
      "headers": {
        "Authorization": "Bearer ${BUTTERBASE_API_KEY}"
      }
    }
  }
}
```

Claude Code、Cursor、Windsurfなど、MCP対応のエディターで使えます。

<span id="mcp-over-http"></span>

### HTTP経由のMCP

接続先は次のエンドポイントです。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTPのMCPセッション |

AuthorizationヘッダーにAPIキーをBearerトークンとして渡します。

<span id="available-tools"></span>

## 利用できるツール

Butterbaseは38のツールを提供します。多くの機能は、`action` を指定する `manage_*` ツールにまとめています。各操作と引数は [MCPツール一覧](/ja/api-reference/mcp-tools)で確認してください。

<span id="app-management"></span>

### アプリ管理

| ツール | 用途 |
|------|--------------|
| **init_app** | バックエンドを新規作成。名前と任意のリージョンを指定し、アプリIDとAPIのベースURLを取得。 |
| **list_regions** | アプリの作成・移動先に選べるリージョンの一覧。 |
| **manage_app** (action: "list") | アクセスできるアプリと情報の一覧。 |
| **manage_app** (action: "delete") | アプリとDBを完全削除。元に戻せません。 |
| **manage_app** (action: "get_config") | CORS、JWT、保存容量などの現在の設定を取得。 |
| **manage_app** (action: "update_cors") | ブラウザーからAPIへアクセスできるオリジンを設定。 |
| **manage_app** (actions: "pause", "update_access_mode", "secure", "set_visibility") | アプリの停止・再開、公開・認証必須の切り替え、テーブルのユーザー分離、テンプレート公開。 |
| **manage_app** (actions: "get_env", "update_env") | アプリ全体の環境変数を取得・設定。 |
| **manage_app** (actions: "find_templates", "clone", "get_clone_job", ...) | 公開テンプレートの検索・複製と、テンプレートのリリース操作。 |
| **manage_app** (actions: "move", "move_status", "teardown_source_replica") | アプリを別リージョンへ移動し、状態を確認。 |
| **manage_migrations** | 進行中のリージョン移動の確認・中断・逆移動。 |
| **manage_auth_config** (action: "update_jwt") | アクセストークンとリフレッシュトークンの有効期間を設定。 |
| **manage_auth_config** (action: "generate_service_key") | `bb_sk_` のAPIキーを生成。 |
| **manage_auth_config** (action: "configure_auth_hook") | 認証が成功した後に呼ぶ関数を設定。 |
| **manage_api_keys** | APIキーの一覧・失効。 |
| **manage_billing** | プラン・使用量の確認、クレジット追加、支出上限の管理。 |

<span id="schema--migrations"></span>

### スキーマとマイグレーション

| ツール | 用途 |
|------|--------------|
| **manage_schema** (action: "get") | アプリの現在のDBスキーマを取得。 |
| **manage_schema** (action: "apply") | 宣言的スキーマを適用。 |
| **manage_schema** (action: "dry_run") | 実行せずにSQLを確認。 |
| **manage_schema** (action: "list_migrations") | スキーマ変更の履歴を取得。 |

<span id="data-operations"></span>

### データ操作

| ツール | 用途 |
|------|--------------|
| **select_rows** | 絞り込み・並べ替え・ページ分割で行を検索。 |
| **insert_row** | テーブルへ行を追加。 |
| **seed_database** | 複数行を一括追加。 |

<span id="authentication--security"></span>

### 認証とセキュリティ

| ツール | 用途 |
|------|--------------|
| **manage_oauth** (actions: "configure", "get", "update", "delete") | ソーシャルログインのプロバイダーを登録・一覧取得・変更・削除。 |
| **manage_rls** (action: "enable") | テーブルのRLSを有効化。 |
| **manage_rls** (action: "create_policy") | 独自RLSポリシーを作成。 |
| **manage_rls** (action: "create_user_isolation") | ユーザー別の行アクセス制御を設定。 |
| **manage_rls** (actions: "list", "update_policy", "delete") | RLSポリシーの一覧・変更・削除。 |
| **manage_auth_users** (actions: "list", "delete") | アプリ利用者の一覧・削除。 |
| **query_audit_logs** | 認証・管理・関数の監査ログを検索。 |

<span id="storage"></span>

### ファイル保存

| ツール | 用途 |
|------|--------------|
| **manage_storage** (action: "upload_url") | 署名付きアップロードURLを取得。 |
| **manage_storage** (action: "download_url") | 署名付きダウンロードURLを取得。 |
| **manage_storage** (action: "list") | アプリのファイル一覧を取得。 |
| **manage_storage** (action: "delete") | ファイルを削除。 |
| **manage_storage** (action: "update_config") | 公開読取の可否とストレージ制限を設定。 |

<span id="serverless-functions-and-durable-objects"></span>

### 関数とDurable Objects

| ツール | 用途 |
|------|--------------|
| **deploy_function** | TypeScript / JavaScript関数をデプロイ。 |
| **invoke_function** | 配信した関数を試しに呼び出す。 |
| **manage_function** (actions: "list", "get", "delete") | 関数の一覧・詳細・削除。 |
| **manage_function** (action: "update_env") | 関数の環境変数を更新。 |
| **manage_function** (action: "get_logs") | 関数の呼び出しログを取得。 |
| **manage_function** (action: "update_settings") | 関数ごとの設定を変更。 |
| **manage_durable_objects** | Durable Objectsのデプロイ・管理と環境変数の設定。 |
| **manage_kv** | アプリのKVの設定・読取・書込。 |

<span id="frontend-deployment"></span>

### フロントエンド配信

| ツール | 用途 |
|------|--------------|
| **create_frontend_deployment** | 配信を作成してアップロードURLを取得。 |
| **manage_frontend** (action: "start_deployment") | アップロード後の配信を開始。 |
| **manage_frontend** (action: "list_deployments") | 配信履歴を取得。 |
| **manage_frontend** (action: "set_env") | ビルドの環境変数を設定。 |
| **manage_frontend** (action: "configure_custom_domain") | 独自ドメインの追加・検証・削除。 |
| **manage_edge_ssr** | Edge SSRのデプロイ・一覧。 |
| **manage_preview** | アプリのプレビューコピーを作成・管理。 |
| **promote_preview** | プレビューの変更を確認し、本番へ反映。 |
| **manage_repo** | アプリのコードスナップショットをpush・pull・確認。 |

<span id="realtime-ai-and-integrations"></span>

### リアルタイム・AI・外部連携

| ツール | 用途 |
|------|--------------|
| **manage_realtime** (actions: "configure", "get") | テーブルの通知を有効化し、設定を取得。 |
| **manage_ai** | AIゲートウェイのチャット・埋め込み・動画・画像・会議ボット。 |
| **manage_agents** | エージェントの定義を作成・管理。 |
| **manage_rag_content** | RAGのコレクションと文書を管理。 |
| **rag_query** | RAGコレクションを意味検索。 |
| **manage_integrations** | 外部ツールキットを有効化し、操作を実行。 |
| **manage_people** | 人物・企業を検索し、情報を補完。 |

<span id="hackathon-feedback--documentation"></span>

### ハッカソン・意見・文書

| ツール | 用途 |
|------|--------------|
| **list_partner_apis** | ハッカソン向けの提携APIを一覧取得。 |
| **prep_and_submit_hackathon_entry** | ハッカソン応募の準備と提出。 |
| **submit_suggestion** | 意見やバグ報告を送信。 |
| **butterbase_docs** | トピックを指定して文書を取得。 |

<span id="generating-an-api-key"></span>

## APIキーを作る

[ダッシュボード](https://dashboard.butterbase.ai)のAPI Keys、またはMCPの `manage_auth_config`（`generate_service_key`）でAPIキーを作れます。`bb_sk_` で始まるキーはアプリやデータへの管理アクセスに使います。
