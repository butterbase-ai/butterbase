---
title: プラットフォームAPI
description: HTTP経由のMCP、エージェント向け情報、サブドメインなどのプラットフォームAPIを説明します。
sidebar:
  order: 9
---

<span id="mcp-over-http"></span>

## HTTP経由のMCP

MCPのツールはHTTP経由でも利用できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTPによるMCPセッション |

`Authorization: Bearer {platform_api_key}`を指定すると、自分のアカウントとして実行します。アシスタントや自動処理がstdio MCPを使えず、HTTPSを呼び出せる場合に利用してください。

<span id="apps--regions"></span>

## アプリとリージョン

概要は[リージョン](/ja/core-concepts/regions/)を参照してください。

<span id="list-supported-regions"></span>

### 対応リージョンの一覧

```http
GET /v1/regions
```

公開APIです。APIキーは不要です。

```json
{ "regions": ["us-east-1", "us-west-2"] }
```

<span id="create-an-app"></span>

### アプリの作成

```http
POST /init
Authorization: Bearer {api_key}

{
  "name": "my-app",
  "region": "us-west-2"
}
```

| フィールド | 必須 | 補足 |
|-------|----------|-------|
| `name` | はい | アプリの表示名。サブドメインの生成にも使用します。 |
| `region` | いいえ | `GET /v1/regions`で取得したリージョン。省略するとプラットフォームの既定値を使います。 |

`{ app_id, api_base_url, region, ... }`を返します。

<span id="move-an-app-to-another-region"></span>

### 別のリージョンへの移動

```http
POST /v1/apps/{app_id}/move
Authorization: Bearer {api_key}

{ "dest_region": "us-east-1" }
```

`{ migration_id, status: "queued" }`を返します。移動中も読み取りはできます。切り替え時に書き込みを一時停止し、移動が完了すると自動で再開します。

<span id="check-move-status"></span>

### 移動状況の確認

```http
GET /v1/apps/{app_id}/migrations/{migration_id}
Authorization: Bearer {api_key}
```

現在の工程、移動元と移動先のリージョン、所要時間を返します。

<span id="agent-guidance"></span>

## エージェント向け情報

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /llms.txt | LLMエージェント向けのプレーンテキストの説明 |

クイックスタート、よく使うパターン、エラーの形式、応答のメタデータを提供します。

<span id="app-access-mode"></span>

## アプリのアクセスモード

匿名リクエストがデータAPIとリアルタイムWebSocketを使えるかを制御します。概要は[アクセスモード](/ja/core-concepts/authentication#access-modes)を参照してください。

| メソッド | パス | 用途 |
|--------|------|---------|
| PATCH | /v1/\{app_id}/config/access-mode | `public`と`authenticated`を切り替える |
| POST | /v1/\{app_id}/secure | `access_mode = "authenticated"`とユーザーごとのRLSポリシーを一括で設定 |

<span id="toggle-access-mode"></span>

### アクセスモードの変更

```json
PATCH /v1/{app_id}/config/access-mode
Authorization: Bearer {token}

{ "access_mode": "authenticated" }
```

<span id="secure-composite"></span>

### secureによる一括設定

```json
POST /v1/{app_id}/secure
Authorization: Bearer {token}

{
  "tables": [
    { "table_name": "posts", "user_column": "author_id" },
    { "table_name": "comments", "user_column": "user_id", "public_read_column": "is_published" }
  ]
}
```

本文が空、または`tables`を省略した場合は、アクセスモードだけを変更します。応答には`tables_secured`と`table_errors`が含まれます。一部のテーブルが失敗しても、呼び出し全体はロールバックしません。

<span id="app-visibility"></span>

## アプリの公開範囲

他のButterbaseユーザーがアプリをテンプレートとして見つけ、複製できるかを制御します。匿名リクエストによるデータAPIの利用を制御する[アクセスモード](#app-access-mode)とは別の設定です。`visibility="public"`と`access_mode="authenticated"`を同時に設定すると、テンプレートを共有しながら匿名のデータ読み取りを制限できます。

`visibility`の既定値は`"private"`です。`"public"`にするとダッシュボードのテンプレート一覧と`GET /v1/templates`に表示されます。`listed: false`を組み合わせると、一覧には表示せず、IDを直接指定した複製だけを許可できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| PATCH | /v1/\{app_id}/config/visibility | `visibility`と任意の`listed`を設定 |

<span id="toggle-visibility"></span>

### 公開範囲の変更

```json
PATCH /v1/{app_id}/config/visibility
Authorization: Bearer {token}

{ "visibility": "public" }
```

応答：

```json
{ "message": "Visibility updated to \"public\"", "app_id": "{app_id}", "visibility": "public", "listed": true }
```

`listed`は任意です。`true`（公開アプリの既定値）なら公開テンプレート一覧に表示します。`"listed": false`なら、直接リンクから利用できる状態を保ちながら一覧では非表示にします。

`visibility`には`"public"`または`"private"`を指定します。既定値は`"private"`です。

<span id="read-current-visibility"></span>

### 現在の公開範囲の取得

`GET /v1/{app_id}/config`は、他のアプリ設定とともに`visibility`と`listed`を返します。

<span id="templates"></span>

## テンプレート

公開アプリのリポジトリのスナップショットを複製し、自分のプロジェクトの出発点にできます。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/templates | 公開アプリのテンプレートを検索（匿名） |
| GET | /v1/templates/\{app_id} | 公開テンプレート1件の詳細を取得 |
| POST | /v1/templates/\{source_app_id}/clone | 公開アプリの複製を開始。`{ job_id }`を返します。 |
| GET | /v1/clone-jobs/\{job_id} | 複製ジョブの状態を取得 |
| POST | /v1/clone-jobs/\{job_id}/retry | 失敗した複製ジョブを再試行 |

<span id="discover-public-templates"></span>

### 公開テンプレートの検索

`GET /v1/templates`は、全リージョンの公開かつ一覧表示が有効なアプリを返します。認証は不要です。`q`（名前の前方一致）、`region`、`sort=recent|popular`、`limit`（最大50）、`offset`に対応します。応答：`{ items: [{ app_id, name, owner_display_name, region, created_at, fork_count, has_repo, schema_summary: { table_count, function_count } }], total, limit, offset }`。

`GET /v1/templates/{app_id}`は、1つのテンプレートの詳細を返します。`tables`、`functions`、`forks_sample`（最新5件の複製）が含まれます。非公開または一覧非表示のアプリには404を返し、存在を知らせません。

<span id="clone-a-public-app"></span>

### 公開アプリの複製

`POST /v1/templates/{source_app_id}/clone`は、呼び出し元が所有するアプリを新規作成して複製します。本文：`{ name?: string, region?: string }`。リージョンの既定値は元のアプリと同じです。元のアプリは公開されている必要があり、非公開なら404を返して存在を知らせません。応答は`{ job_id, status: "pending" }`です。

`GET /v1/clone-jobs/{job_id}`を、`status`が`"completed"`（新しい`dest_app_id`を含む）または`"failed"`（`error_message`を含む）になるまでポーリングします。失敗したジョブは`POST /v1/clone-jobs/{job_id}/retry`で再試行できます。

**複製するもの：** データベースのスキーマ（テーブル、列、インデックス）、行レベルセキュリティのポリシー、関数コード、複製時点の最新リポジトリファイル、シークレットを含まない設定（ストレージ、許可するオリジン、OAuthプロバイダーとURL、既定のAIモデル）、作者が初期データとして指定したテーブルの行。

**複製しないもの：** エンドユーザーのアカウントとセッション、OAuthクライアントの認証情報、関数の環境変数、持ち込みのAIプロバイダーキー（BYOK）、カスタムドメイン、課金情報、関数の呼び出し履歴、監査ログ。複製したアプリの所有者が設定してください。詳細は[複製する内容](/ja/core-concepts/database#what-a-clone-copies)を参照してください。

<span id="app-repo"></span>

## アプリのリポジトリ

コードを内容のハッシュで識別するスナップショットとしてアプリへ送信できます。複数の端末から利用するバックアップや、ファイルの基準となる保存先に使えます。変更のないファイルは再送信しません。最新5件のスナップショットを保持します。

リポジトリの内容はアプリのオブジェクトストレージの予約済みプレフィックス配下へ保存します。通常のストレージオブジェクトとは**別扱い**で、専用の2段階のアップロードを使います。

送信は2段階です。

1. `prepare`：ファイルのパス、sha256、サイズを含むマニフェストを送信します。サーバーが検証し、未保存のデータに対する署名付きPUT URLを返します。
2. `commit`：指定されたデータを返されたURLでS3へアップロードし、マニフェストを再送します。サーバーが全データのサイズを検証してマニフェストを保存し、`latest`を新しいスナップショットへ切り替えます。

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/repo/snapshots/prepare | マニフェストを検証し、未保存のデータ用の署名付きPUT URLを取得 |
| POST | /v1/\{app_id}/repo/snapshots/commit | 全データのアップロード後にスナップショットを確定 |
| GET | /v1/\{app_id}/repo/snapshots | スナップショットの履歴を取得（新しい順） |
| GET | /v1/\{app_id}/repo/snapshots/latest | 現在のスナップショットのマニフェストを取得 |
| GET | /v1/\{app_id}/repo/snapshots/\{snapshot_id} | 指定したスナップショットのマニフェストを取得 |
| GET | /v1/\{app_id}/repo/blobs/\{sha256} | 1つのデータ用の署名付きGET URLを取得 |
| POST | /v1/\{app_id}/repo/blobs/batch | 複数のデータ用のダウンロードURLをまとめて取得 |
| DELETE | /v1/\{app_id}/repo | リポジトリを全削除 |

**公開**アプリの読み取り（`GET`）には認証が不要です。**非公開**アプリの読み書きは所有者だけに許可します。

<span id="manifest-shape"></span>

### マニフェストの形式

```json
{
  "files": [
    { "path": "src/index.ts", "sha256": "<64 hex>", "size": 1234 }
  ],
  "message": "optional push message"
}
```

パスは相対パスで、ASCIIの安全な文字だけを使います。`..`の要素、先頭の`/`、バックスラッシュ、ヌル文字を含められません。パスは最大4KB、ファイルは最大10MB、スナップショットは最大100MBです。

<span id="prepare"></span>

### 準備

```json
POST /v1/{app_id}/repo/snapshots/prepare
Authorization: Bearer {token}

{ "files": [ { "path": "a.txt", "sha256": "...", "size": 5 } ] }
```

応答：

```json
{
  "snapshot_id": "<64 hex>",
  "total_bytes": 5,
  "file_count": 1,
  "missing_blobs": [ { "sha256": "...", "uploadUrl": "https://..." } ]
}
```

各`missing_blob.uploadUrl`へ`PUT`でアップロードします。署名付きURLは10分で失効します。

<span id="commit"></span>

### 確定

```json
POST /v1/{app_id}/repo/snapshots/commit
Authorization: Bearer {token}

{ "manifest": { "files": [ ... ], "message": "..." } }
```

未保存のデータ、またはマニフェストとサイズが合わないデータがある場合、409と`details.missing_shas`、`details.size_mismatches`を返します。該当するデータを再アップロードしてから確定を再試行してください。

<span id="pull"></span>

### 取得

```http
GET /v1/{app_id}/repo/snapshots/latest
```

`{ snapshot_id, manifest }`を返します。マニフェストの各ファイルについて、`GET /v1/{app_id}/repo/blobs/{sha256}`で署名付きGET URL（有効期限1時間）を取得し、ダウンロードしてください。

<span id="wipe"></span>

### 全削除

`DELETE /v1/{app_id}/repo`は、全スナップショット、データ、`latest`の参照を削除します。元に戻せません。

<span id="snapshot-history"></span>

### スナップショットの履歴

`GET /v1/{app_id}/repo/snapshots`は、`{ snapshots: [{ snapshot_id, created_at }] }`を新しい順で返します。公開範囲のルールは`latest`と同じです。公開アプリは認証不要、非公開は所有者専用で、それ以外には404を返します。

<span id="batch-blob-presign"></span>

### 複数データの署名付きURL

`POST /v1/{app_id}/repo/blobs/batch`は`{ shas: string[] }`（最大1000件）を受け取り、`{ blobs: [{ sha256, size, downloadUrl, expiresIn }] }`を返します。存在しない、または削除済みのハッシュは応答に含まれないため、取得件数が指定件数より少ない場合があります。公開範囲は単一データのAPIと同じです。公開アプリは認証不要、非公開は所有者専用です。

多数のファイルを含むマニフェストを、ファイルごとの通信を減らして取得できます。MCPの`manage_repo`の`pull_latest`でも内部で使用します。

<span id="per-app-subdomains"></span>

## アプリごとのサブドメイン

サブドメインのルーティングが有効な場合、アプリの名前からサブドメインを作成します。`https://{subdomain}.{base_domain}`へのアクセスではHostヘッダーからアプリを解決するため、パスの`{app_id}`を省略できます。

| サブドメインのパス | 用途 |
|----------------|-------------------|
| /data/\{table} | データAPIのCRUD |
| /fn/\{function_name} | 関数を呼び出す |
| /auth/signup, /auth/login, ... | エンドユーザーの認証 |
| /storage/upload, /storage/objects, ... | ファイルストレージ |
| /schema, /schema/apply, /migrations | スキーマ管理 |

<span id="product-suggestions"></span>

## 製品への提案

**MCPツール：** `submit_suggestion`

**HTTP：**

```json
POST /suggestions
Authorization: Bearer {api_key}

{
  "category": "feature_request",
  "description": "Add support for GraphQL subscriptions",
  "severity": "medium",
  "source": "human_prompted"
}
```

| フィールド | 必須 | 値 |
|-------|----------|--------|
| `category` | はい | `bug_report`, `feature_request`, `improvement`, `documentation` |
| `description` | はい | 説明文 |
| `severity` | いいえ | `low`, `medium`, `high`, `critical` |
| `affected_tool` | いいえ | 該当する場合はツール名 |
| `proposed_solution` | いいえ | 修正案 |
| `source` | いいえ | `agent`または`human_prompted` |

<span id="health-checks"></span>

## ヘルスチェック

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /health | 稼働確認 |
| GET | /health/ready | 準備状況の確認（データベース接続） |

<span id="error-format"></span>

## エラーの形式

エラーはすべて構造化したオブジェクトを含みます。

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Table 'nonexistent' does not exist",
    "remediation": "Check the table name and ensure it exists in your schema",
    "documentation_url": "https://docs.butterbase.ai/api-reference/data-api"
  }
}
```

再試行する前に`remediation`の内容に従ってください。

<span id="rate-limiting"></span>

## レート制限

認証などの機密性の高いエンドポイントには厳しい個別のレート制限があります。他のエンドポイントにも、環境の設定に応じて制限が適用される場合があります。
