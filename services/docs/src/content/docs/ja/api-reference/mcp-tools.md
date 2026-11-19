---
title: MCPツール
description: AIアシスタントが利用するMCPツールのリファレンスです。
sidebar:
  order: 8
---

OSS版のMCPサーバーが公開するツールに加え、ホステッド版では`manage_substrate`を利用できます。多くの機能は`action`で操作を選ぶ`manage_*`ツールにまとめています（例：`manage_schema`の`action: "apply"`）。

MCPへ接続すると利用できます。接続方法は[MCPの設定](/ja/getting-started/mcp-setup)を参照してください。

<span id="app-management"></span>

## アプリ管理

| ツール | 説明 |
|------|-------------|
| `init_app` | アプリを新規作成。任意の`region`を指定できます。app_idとAPIベースURLを返します。 |
| `list_regions` | アプリを作成・移動できるリージョンの一覧 |
| `manage_app` | アプリの一覧、削除、一時停止、アクセス・公開範囲の設定、リージョン移動、テンプレート複製、Webhook設定。以下の操作を参照してください。 |

<span id="manage_app-actions"></span>

### manage_appの操作

| 操作 | 説明 |
|--------|-------------|
| `list` | メタデータ付きの全アプリ一覧 |
| `delete` | アプリを完全に削除。元に戻せません。 |
| `pause` | データ処理の通信をすべて一時停止・再開。停止中は503（`APP_PAUSED`）を返します。 |
| `get_config` | アプリの設定（CORS、JWT、ストレージ上限）を取得 |
| `secure` | `access_mode = "authenticated"`と指定した`tables`のユーザー分離RLSポリシーを一括設定 |
| `update_cors` | CORSで許可するオリジンを設定 |
| `update_access_mode` | 匿名アクセスと認証必須を切り替える |
| `set_visibility` | 公開・非公開を設定。任意でテンプレート一覧の`listed`も指定できます。 |
| `move` | `dest_region`へ移動し、`migration_id`を返します。移動中も読み取りできます。 |
| `move_status` | `move`の`migration_id`で進行状況を確認 |
| `teardown_source_replica` | 完了した移動の`migration_id`を指定し、保持中の移動元のレプリカを廃止 |
| `preview_clone_env_vars` | 複製前に、元の関数とDurable Objectsが必要とする環境変数を確認。`source_app_id`を指定。 |
| `find_templates` | 公開・一覧表示が有効なテンプレートを検索。任意の`q`（前方一致）、`region`、`sort`（`recent`・`popular`）、`limit`（最大50）、`offset`。応答：`{ items: [...], total, limit, offset }`。 |
| `clone` | `source_app_id`の公開アプリを複製。任意の`name`・`region`。応答：`{ job_id, status: "pending" }`。 |
| `get_clone_job` | `job_id`で複製状況を確認。`status`（`pending`・`completed`・`failed`）、完了時の`dest_app_id`、失敗時の`error_message`を返します。 |
| `set_clone_webhook` | 複製時のWebhookを設定。`webhook_url`・`webhook_secret`を指定し、削除には`clear_webhook: true`を使います。 |
| `link_substrate` / `unlink_substrate` / `set_substrate_autopropagate` | アプリとSubstrateの紐付け・解除、イベントの自動伝播を設定 |
| `publish_template_release` / `list_template_releases` / `get_template_release` / `check_template_updates` / `update_from_template` | テンプレートのバージョン付きリリースを公開し、複製先で更新を確認・取得 |
| `get_env` | アプリの環境変数の**キー名だけ**を取得。値は返しません。応答：`{ keys: string[], updated_at }`。[環境変数](/ja/core-concepts/functions/#environment-variables)を参照。 |
| `update_env` | アプリの環境変数をマージ。`env: { KEY: "value" }`で設定、`env: { KEY: null }`で削除。全関数の`ctx.env.<KEY>`で使用できます。`updated_keys`とキャッシュを無効化した関数一覧を返します。`/^BUTTERBASE_/i`は予約済みです。 |

<span id="schema--migrations"></span>

## スキーマとマイグレーション

| ツール | 説明 |
|------|-------------|
| `manage_schema` | スキーマとマイグレーションの取得、適用、プレビュー、一覧 |
| `manage_migrations` | リージョン移動の取得と制御（`manage_app`の`move`を補完） |

<span id="manage_schema-actions"></span>

### manage_schemaの操作

| 操作 | 説明 |
|--------|-------------|
| `get` | 現在のスキーマを取得 |
| `apply` | 宣言したスキーマを適用。`schema`と任意の`name`を指定。 |
| `dry_run` | 実行せずにSQLを確認 |
| `list_migrations` | マイグレーション履歴を表示 |

<span id="manage_migrations-actions"></span>

### manage_migrationsの操作

| 操作 | 説明 |
|--------|-------------|
| `get_active` | 実行中のマイグレーション、または`{ migration: null }`を取得 |
| `abort` | 切り替え前の移動を中止。`migration_id`を指定。 |
| `reverse` | 移動元のレプリカが残っている間、完了した移動を元に戻す。`migration_id`を指定。 |
| `list_source_replicas` | 保持中の移動元レプリカを一覧表示 |

<span id="data-operations"></span>

## データ操作

| ツール | 説明 |
|------|-------------|
| `select_rows` | 絞り込み、並び替え、ページ分割で行を取得 |
| `insert_row` | 行を1件追加 |
| `seed_database` | 最大100行を一括追加。プラットフォームのロールで実行し、RLSを適用しません。 |

<span id="authentication--security"></span>

## 認証とセキュリティ

| ツール | 説明 |
|------|-------------|
| `manage_oauth` | ソーシャルログインのプロバイダーを設定 |
| `manage_rls` | テーブルの行レベルセキュリティを管理 |
| `manage_auth_config` | 認証フック、JWTの有効期間、サービスキーを管理 |
| `manage_auth_users` | エンドユーザーの一覧・削除 |
| `manage_api_keys` | プラットフォームAPIキーの一覧・失効 |
| `query_audit_logs` | 認証、管理、関数の監査ログを検索 |

<span id="manage_oauth-actions"></span>

### manage_oauthの操作

| 操作 | 説明 |
|--------|-------------|
| `configure` | プロバイダーを登録（`provider`、`client_id`、`client_secret`、`redirect_uris`） |
| `get` | 全プロバイダー、または`provider`指定で1件を取得 |
| `update` | プロバイダーを変更 |
| `delete` | プロバイダーを削除 |

<span id="manage_rls-actions"></span>

### manage_rlsの操作

| 操作 | 説明 |
|--------|-------------|
| `enable` | `table_name`にRLSを有効化 |
| `create_policy` | 独自ポリシーを作成（`table_name`、`policy_name`、`command`、`role`、`using_expression`、`with_check_expression`、任意の`user_column`） |
| `update_policy` | 既存のポリシーを変更 |
| `create_user_isolation` | ユーザー分離を設定。`table_name`、`user_column`、任意の`public_read_column`。 |
| `list` | 有効なポリシー一覧 |
| `delete` | `policy_name`の1件、またはテーブルの全ポリシーを削除 |

`access_mode`の変更や複数テーブルの一括保護には、`manage_app`の`update_access_mode`と`secure`を使います。

<span id="manage_auth_config-actions"></span>

### manage_auth_configの操作

| 操作 | 説明 |
|--------|-------------|
| `configure_auth_hook` | 認証イベントの成功後に実行する関数を設定・解除 |
| `update_jwt` | アクセストークンと更新トークンの有効期間を変更 |
| `generate_service_key` | サービスキーを発行 |

<span id="manage_auth_users-actions"></span>

### manage_auth_usersの操作

| 操作 | 説明 |
|--------|-------------|
| `list` | ユーザー一覧（`limit`、`cursor`） |
| `delete` | `user_id`でユーザーを削除 |

<span id="manage_api_keys-actions"></span>

### manage_api_keysの操作

| 操作 | 説明 |
|--------|-------------|
| `list` | APIキー一覧（`bb_sk_`で始まるキー） |
| `revoke` | `key_id`でキーを失効 |

<span id="app-repo"></span>

## アプリのリポジトリ

| ツール | 説明 |
|------|-------------|
| `manage_repo` | アプリのリポジトリを送信、取得、確認、全削除。MCPの送信は約1MBまでです。大きなスナップショットは`butterbase repo push`を使ってください。 |

<span id="storage"></span>

## ストレージ

| ツール | 説明 |
|------|-------------|
| `manage_storage` | 署名付きアップロード・ダウンロードURL、ファイルの一覧・削除、設定 |

<span id="manage_storage-actions"></span>

### manage_storageの操作

| 操作 | 説明 |
|--------|-------------|
| `upload_url` | アップロードURLを取得。`filename`、`content_type`、`size_bytes`を指定し、`object_id`を返します。 |
| `download_url` | `object_id`のダウンロードURLを取得 |
| `list` | 全ファイルを一覧表示 |
| `delete` | `object_id`で削除 |
| `update_config` | アプリ全体の公開読み取りとストレージ上限を設定 |

<span id="serverless-functions"></span>

## サーバーレス関数

| ツール | 説明 |
|------|-------------|
| `deploy_function` | TypeScript・JavaScriptの関数をデプロイ |
| `invoke_function` | 関数をテスト実行 |
| `manage_function` | 関数の一覧、確認、削除、設定、ログ取得 |

<span id="manage_function-actions"></span>

### manage_functionの操作

| 操作 | 説明 |
|--------|-------------|
| `list` | デプロイ済みの関数一覧 |
| `get` | 関数の詳細を取得 |
| `delete` | 関数を削除 |
| `get_logs` | 呼び出しログを表示 |
| `update_env` | **関数単位**の環境変数を更新。アプリの同名キーより優先します。全関数で共有する値は`manage_app`の`update_env`を使います。[環境変数](/ja/core-concepts/functions/#environment-variables)を参照。 |
| `update_settings` | `allow_service_key_impersonation`などの設定を更新 |

## Durable Objects

| ツール | 説明 |
|------|-------------|
| `manage_durable_objects` | Durable Objectsのデプロイと管理 |

<span id="manage_durable_objects-actions"></span>

### manage_durable_objectsの操作

`deploy`, `list`, `get`, `delete`, `usage`, `list_env`, `set_env`, `delete_env`.

<span id="frontend-deployment"></span>

## フロントエンドのデプロイ

| ツール | 説明 |
|------|-------------|
| `create_frontend_deployment` | デプロイを作成し、アップロードURLを取得 |
| `manage_frontend` | デプロイ開始、履歴、ビルド環境変数、カスタムドメインの管理 |
| `manage_edge_ssr` | Edge SSR（Cloudflare Workers）のデプロイと一覧 |

<span id="manage_frontend-actions"></span>

### manage_frontendの操作

| 操作 | 説明 |
|--------|-------------|
| `start_deployment` | アップロード後に開始。`deployment_id`を指定。 |
| `list_deployments` | デプロイ履歴を表示 |
| `create_from_source` / `start_from_source` | ソースZIPからサーバー側でビルド |
| `set_env` | ビルド環境変数（`vars`）を設定 |
| `configure_custom_domain` | `domain_action`（`add`、`list`、`status`、`verify`、`remove`）でドメインを追加、一覧、確認、検証、削除 |

<span id="manage_edge_ssr-actions"></span>

### manage_edge_ssrの操作

`create`, `start`, `create_from_source`, `start_from_source`, `list`.

<span id="previews"></span>

## プレビュー

| ツール | 説明 |
|------|-------------|
| `manage_preview` | 本番のコピーとしてプレビューを作成・管理。操作：`create`、`status`、`reset`、`get_env_overrides`、`set_env_overrides`。 |
| `promote_preview` | プレビューの構造とコードを本番へ反映。操作：`check`、`run`。 |

<span id="realtime"></span>

## リアルタイム

| ツール | 説明 |
|------|-------------|
| `manage_realtime` | リアルタイムの有効化・設定取得。操作：`configure`（`tables`を有効化）、`get`。 |

<span id="ai-gateway"></span>

## AIゲートウェイ

AIの操作は`manage_ai`にまとめています。`{ app_id, action, ... }`の`action`で選択します。

| 操作 | 説明 |
|--------|-------------|
| `chat` | 同期のチャット補完（OpenAI互換）。`messages`、任意の`model`、`temperature`、`max_tokens`。 |
| `embed` | 埋め込みを生成。`input`（文字列または配列）、任意の`model`、`encoding_format`。 |
| `list_models` | アプリで利用できるチャット・埋め込み・動画モデル一覧 |
| `get_config` | AI設定（既定モデル、許可モデル、トークン上限）を取得 |
| `update_config` | 持ち込みキー（BYOK）の更新、既定モデル、許可モデルを設定 |
| `get_usage` | 期間内のトークン数とクレジット消費を集計 |
| `submit_video` | 非同期の動画生成。`model`、`prompt`、任意の`duration`、`resolution`、`aspect_ratio`、`generate_audio`、`seed`。応答：`{ job_id, status, polling_url }`。 |
| `poll_video` | `job_id`で状態を確認。`completed`なら絶対URLの`content_urls`と`charged_credits_usd`を返します。 |
| `configure_meetings_webhook` | 会議ボットの転送先を設定。`forward_url`と、任意の`rotate_secret: true`で署名用シークレットを更新します。シークレットは**1回だけ**返します。[署名の検証](/ja/api-reference/ai-meetings-api/#verifying-the-signature)を参照してください。 |
| `decide` | 選択肢を限定した判断 |
| `submit_image` / `poll_image` | 非同期の画像生成を送信・確認 |
| `start_meeting` / `get_meeting` / `list_meetings` / `stop_meeting` / `estimate_meeting` | 会議ボットを起動、取得、一覧、停止、料金見積もり |
| `usage_meetings` | 会議の使用量。`actor_id`、項目（`recording`・`transcription`）、`seconds`、`usd_charged`、`created_at`。最新100件。 |

HTTPの形式と動画生成の一連の例は[AI APIリファレンス](/ja/api-reference/ai-api/)を参照してください。

<span id="rag-retrieval-augmented-generation"></span>

## RAG（検索拡張生成）

| ツール | 説明 |
|------|-------------|
| `manage_rag_content` | コレクションと文書を管理 |
| `rag_query` | コレクションの意味検索。順位付きのチャンクを返し、任意でAIの回答を生成。 |

<span id="manage_rag_content-actions"></span>

### manage_rag_contentの操作

| 操作 | 説明 |
|--------|-------------|
| `create_collection` | 文書の保存と検索用のコレクションを作成 |
| `list_collections` | 文書数付きのコレクション一覧 |
| `get_collection` | コレクションを1件取得 |
| `delete_collection` | コレクションと文書、チャンク、埋め込みを全削除 |
| `ingest_document` | テキストまたはアップロード済みファイルを非同期で取り込み。文書IDを返します。 |
| `list_documents` | 状態とメタデータ付きの文書一覧 |
| `get_document_status` | 取り込み状態を確認（`pending`、`processing`、`ready`、`failed`） |
| `delete_document` | 文書とベクトルチャンクを削除 |

<span id="integrations"></span>

## 外部サービスとの連携

| ツール | 説明 |
|------|-------------|
| `manage_integrations` | GmailやSlackなどのツールキットを有効化し、操作を実行 |

<span id="manage_integrations-actions"></span>

### manage_integrationsの操作

| 操作 | 説明 |
|--------|-------------|
| `configure` | アプリのツールキットを有効化 |
| `rotate_credentials` | OAuthの認証情報を更新 |
| `disable` | ツールキットを無効化 |
| `list_available` | 選定されたツールキット一覧、または全体から検索 |
| `list_connected` | アプリにアカウントを接続したユーザー一覧 |
| `list_tools` | 接続済みツールキットの実行可能なツール一覧 |
| `execute_action` | ユーザーに代わってツールを実行 |

<span id="agents"></span>

## エージェント

| ツール | 説明 |
|------|-------------|
| `manage_agents` | エージェント定義の管理。操作：`list`、`get`、`create`、`update`、`delete`、`validate`。 |

<span id="people-people--company-search--enrichment"></span>

## 人物と企業の検索・情報補完

| ツール | 説明 |
|------|-------------|
| `manage_people` | 人物・企業の条件検索や意味検索、LinkedIn URLからの情報補完（30日キャッシュ）、非同期の勤務先メール検索。ユーザーのクレジットから課金します。[人物検索API](/ja/api-reference/people-api/)にHTTP形式と料金を掲載しています。 |

各操作は、設定可能な2つの接続先（`primary`、`secondary`）のいずれかへ送信します。運営者がデプロイ時に指定し、MCPの呼び出し元には公開しません。

<span id="manage_people-actions"></span>

### manage_peopleの操作

すべて`{ app_id, action, ... }`の`action`で操作を選択します。

| 操作 | 説明 |
|--------|-------------|
| `search_person` | 構造化したフィルターと自由文の`query`による人物検索。`query`があれば優先します。フィルター：`current_role_title`、`past_role_title`、`current_company_name`、`current_company_industry`、`country`、`region`、`city`、`education_school_name`、`education_degree_name`、`education_field_of_study`、`page_size`、`next_token`。論理演算子は順位の参考です。0件なら無料。 |
| `search_company` | 企業の条件検索・意味検索。`query`と、`industry`、`country`、`employee_count_max`、`page_size`、`next_token`。 |
| `get_profile` | `linkedin_profile_url`でプロフィールを取得。`live_fetch: "force"`でキャッシュを省略。未取得は2クレジット、キャッシュは無料。TTL：成功30日、404は7日、失敗1時間。 |
| `queue_email_lookup` | `linkedin_profile_url`で非同期検索を受付。`lookup_id`と`status: "pending"`を返し、`get_email_lookup`で確認します。目安は受付時3クレジット、確定時1クレジット。 |
| `set_byok_key` / `clear_byok_key` | 自分のプロバイダーキー（BYOK）を保存・削除 |
| `get_email_lookup` | `id`で検索結果を確認。応答：`{ status, email, credits_consumed }`。 |

<span id="search-examples"></span>

### 検索の例

```jsonc
// Semantic query — natural-language description of the ideal match
{
  "action": "search_person",
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "page_size": 25
}

// Structured filters — boolean syntax honored as ranking hints
{
  "action": "search_person",
  "current_role_title": "(VP OR \"Vice President\") AND NOT assistant",
  "education_school_name": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "page_size": 25
}

// Company search
{
  "action": "search_company",
  "industry": "Financial Services",
  "employee_count_max": 200,
  "country": "US"
}

// Profile lookup — cache absorbs duplicates within 30 days
{ "action": "get_profile", "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123" }
```

<span id="pricing-summary"></span>

### 料金の概要

料金は運営者の接続先指定により異なります。表は通常の目安です。実際の料金は`x-people-*`ヘッダーと本文の`usage`で確認できます。全体の料金表は[人物検索API](/ja/api-reference/people-api/#pricing)を参照してください。

| 操作 | 通常のクレジット数 | 通常の米ドル料金 |
|---|---|---|
| `search_person` / `search_company`（最大10件） | 7 | $0.0084 |
| `get_profile`のキャッシュ未取得 | 2 | $0.040 |
| `get_profile`のキャッシュ取得 | 0 | $0 |
| `queue_email_lookup`の受付 | 3 | $0.060 |
| Webhookによるメール確定 | 1 | $0.020 |
| 検索結果なし（0件） | 0 | $0 |

<span id="errors"></span>

### エラー

`manage_people`は、control-apiのエラー文と`isError: true`を返します。主な原因は次のとおりです。

- `insufficient_credits`（402）：残高が最低利用額（既定値0.05米ドル）未満です。プロバイダーは呼び出しません。
- `forbidden`（403）：認証済みのユーザーがアプリの所有者ではありません。
- `people_disabled`（503）：この環境で機能フラグが無効です。
- `people_unavailable`（503）：機能が無効、または必要なプラットフォーム設定がありません。
- `provider_not_registered`（503）：運営者の設定不備。指定の枠にプロバイダーがありません。
- `provider_action_unsupported`（503）：運営者の設定不備。指定の枠のプロバイダーが操作に対応していません。

<span id="conceptual-notes"></span>

### 利用時の補足

- **キャッシュで料金を抑える。** 同じ正規化済みのLinkedIn URLを30日以内に再取得する`get_profile`は無料です。再表示時にも取得できます。
- **検索結果が0件ならクレジットも0。** `page_size: 1`で`data.totalResultCount`を確認し、次のページを取得する前の料金の目安に使えます。
- **メール検索は非同期。** 受付はすぐに返し、結果は数分後にWebhookで届きます。UIに`pending`状態を用意してください。
- この提供範囲では**電話番号に対応していません**。

<span id="kv-store"></span>

## KVストア

| ツール | 説明 |
|------|-------------|
| `manage_kv` | KVの公開ルールと、取得・保存・削除・加減算などのデータ操作 |

<span id="manage_kv-actions"></span>

### manage_kvの操作

| 操作 | 説明 |
|--------|-------------|
| `list_rules` | 全名前空間の公開ルール一覧 |
| `expose` | キーパターンの読み書き権限を設定 |
| `unexpose` | パターンで公開ルールを削除 |
| `stats` | 使用量（キー数、メモリなど）を取得 |
| `scan` | プレフィックスで走査（カーソルによるページ分割） |
| `flush` | 全キーを削除（`confirm: true`が必須） |
| `get` | キーの値を取得 |
| `set` | 値を保存。任意のTTLと一時層の指定。 |
| `del` | キーを1件削除 |
| `incr` | 整数値を加算 |
| `decr` | 整数値を減算 |
| `setnx` | 存在しない場合だけ保存 |
| `setex` | 秒単位のTTLを指定して保存 |
| `cas` | 現在値がexpectedと一致する場合だけnextへ不可分に置換 |
| `exists` | キーの存在を確認 |
| `ttl` | 残りのTTLを秒単位で取得 |
| `expire` | 既存のキーにTTLを設定 |
| `mget` | 複数の値を一括取得 |
| `mset` | 複数のキーと値を一括保存 |

<span id="manage_kv-example"></span>

### manage_kvの例

```json
{
  "action": "manage_kv",
  "app_id": "app_abc123",
  "action": "set",
  "key": "counter:requests",
  "value": 42,
  "ttl": 3600
}
```

## Substrate

> ホステッド版（butterbase.ai）専用です。`manage_substrate`はマネージドサービスに含まれ、OSS版のMCPサーバーでは提供しません。

Substrateの操作は`manage_substrate`にまとめています。`{ action, ... }`で選択します。呼び出すユーザーは認証情報から決まるため、`app_id`や`substrate_user_id`は指定しません。各呼び出しは自分のSubstrateを操作します。

| ツール | 説明 |
|------|-------------|
| `manage_substrate` | 自分のSubstrateの読み書き。アクション、台帳、エンティティ、元資料、メモリー、Outbox、注意ルール、スナップショット、yolo設定を管理。 |

<span id="manage_substrate-actions"></span>

### manage_substrateの操作

決定、約束、学び、エンティティ、元資料、外部への操作など、すべての書き込みで該当する`capability`を指定して`propose`を使います。

| 操作 | 説明 |
|--------|-------------|
| `propose` | `capability`と`payload`で提案。任意の`idempotency_key`、`dangerously_skip_approval`。応答：`{ action_id, verdict, requires_approval, result? }`。 |
| `approve` | `action_id`の承認待ちアクションを承認 |
| `reject` | `action_id`を拒否。任意の`reason`。 |

アクションの台帳。

| 操作 | 説明 |
|--------|-------------|
| `list_actions` | 台帳一覧。任意の`status`（`proposed`・`executed`・`rejected`）、`capability`、`source_app_id`、`source_rule_id`、`limit`（1〜500、既定100）、`before`（ISO日時）。 |
| `get_action` | `action_id`で取得 |

エンティティ。

| 操作 | 説明 |
|--------|-------------|
| `find_entities` | エンティティ検索。任意の`type`（`person`・`company`・`fund`・`workspace`・`team`・`project`・`event`・`agent`・`self`）、`q`（表示名）、`limit`（1〜200、既定50）。 |
| `get_entity` | `entity_id`で取得 |

元資料。会議の文字起こし、メール、録音、文書などの永続的な資料で、決定・約束・学びから参照できます。

| 操作 | 説明 |
|--------|-------------|
| `list_source_artifacts` | 元資料の一覧・全文検索。任意の`kind`、`q`（title＋summary＋content）、`limit`、`count`（`true`で`total`を含む）。 |
| `get_source_artifact` | `artifact_id`で全文の`content`を含めて取得 |

メモリー。

| 操作 | 説明 |
|--------|-------------|
| `search_memory` | メモリーの全文検索。`q`、任意の`kinds`（`decisions`・`commitments`・`learnings`・`source_artifacts`、既定はすべて）、`limit`。 |

Outbox。

| 操作 | 説明 |
|--------|-------------|
| `list_outbox` | 配信一覧。任意の`status`と`limit`。 |
| `retry_outbox` | `outbox_id`の失敗した配信を再試行 |
| `cancel_outbox` | `outbox_id`の待機中の配信を中止 |

注意ルール。

| 操作 | 説明 |
|--------|-------------|
| `list_rules` | ルール一覧。任意の`enabled`で絞り込み。 |
| `get_rule` | `rule_id`で取得 |
| `create_rule` | `rule`を指定して作成。[Substrate API](/ja/api-reference/substrate-api/#attention-rules)に本文を掲載。 |
| `update_rule` | `rule_id`と`rule`で更新 |
| `delete_rule` | `rule_id`で削除 |
| `enable_rule` | `rule_id`を有効化 |
| `disable_rule` | `rule_id`を無効化 |
| `list_rule_firings` | 発火履歴。`rule_id`、任意の`status`、`limit`、`before`。 |

スナップショットと設定。

| 操作 | 説明 |
|--------|-------------|
| `snapshots` | 日次スナップショット一覧。任意の`days`（既定7）。 |
| `get_settings` | ユーザー設定（yoloモードなど）を取得 |
| `set_yolo` | `yolo_mode: true`または`false`で切り替え |

<span id="manage_substrate-example"></span>

### manage_substrateの例

```json
{
  "tool": "manage_substrate",
  "action": "propose",
  "capability": "upsert_source_artifact",
  "payload": {
    "kind": "meeting_transcript",
    "title": "Weekly product sync — 2026-06-09",
    "external_system": "fireflies",
    "external_id": "abc123",
    "content": "Alice: we should ship phase 6 by Friday…"
  }
}
```

<span id="billing"></span>

## 課金

| ツール | 説明 |
|------|-------------|
| `manage_billing` | アカウントの課金管理。操作：`status`、`portal`、`topup`、`cap_get`、`cap_raise`、`plans`、`usage`。 |

<span id="partner-apis--regions"></span>

## パートナーAPIとリージョン

| ツール | 説明 |
|------|-------------|
| `list_partner_apis` | ハッカソンで利用できるパートナーAPI一覧 |
| `list_regions` | 利用できるリージョン一覧 |

<span id="hackathon"></span>

## ハッカソン

いずれかのハッカソンの応募期間中に一覧へ表示します。複数のハッカソンが同時に開催される場合があるため、対象を指定するツールには`hackathon_slug`が必要です。[ハッカソン](/ja/hackathon)を参照してください。

| ツール | 説明 |
|------|-------------|
| `prep_and_submit_hackathon_entry` | 2段階の提出。`prep`は`submission_code`から対象と`field_schema`、各フィールドの仮値を含む`next_call`を返します。確認した`data`を`submit`へ送り、`matched.slug`を`hackathon_slug`に使います。初回は`submission_code`も必要です。`manage_app`の`list`で取得した`app_id`も指定すると、自動採点と審査でアプリを確認できます。 |

<span id="feedback--documentation"></span>

## フィードバックとドキュメント

| ツール | 説明 |
|------|-------------|
| `submit_suggestion` | フィードバック、不具合、機能要望を送信 |
| `butterbase_docs` | トピック別のドキュメントを取得 |
