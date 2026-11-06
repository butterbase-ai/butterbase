---
title: エラーリファレンス
description: Butterbase APIのエラーコード、意味、対処方法の一覧です。
---

すべてのAPIエラーは、エージェントからも扱いやすい`AgentFriendlyError`の形式を使います。

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "App \"my-app\" not found",
    "remediation": "Verify the app_id is correct. Use manage_app with action "list" to see available apps.",
    "documentation_url": "https://docs.butterbase.ai/errors#resource-not-found",
    "details": { }
  }
}
```

documentation_urlは該当する見出しへのリンクです。以下は分類別の一覧です。

<span id="validation-errors"></span>

## 検証エラー

本文、スキーマ、入力値の形式や検証の問題です。通常はHTTP 400 Bad Requestです。

<span id="validation-invalid-schema"></span>

### スキーマが不正

**コード：** `VALIDATION_INVALID_SCHEMA`
**ステータス：** 400

必須項目の不足、形式の違い、無効な組み合わせなどで本文がスキーマに一致しません。

**対処：** detailsの検証結果を読み、呼び出したAPIの仕様と比較して修正してください。

<span id="validation-missing-field"></span>

### 必須フィールドの不足

**コード：** `VALIDATION_MISSING_FIELD`
**ステータス：** 400

本文に必須フィールドがありません。

**対処：** detailsの項目を追加してください。必須項目は各APIの説明で確認できます。

<span id="validation-invalid-type"></span>

### 型が不正

**コード：** `VALIDATION_INVALID_TYPE`
**ステータス：** 400

JSONの型が異なります。例えば配列の代わりに文字列、数値列に数値以外を指定しています。

**対処：** 指定された型へ直してください。JSON列には文字列化したJSONではなく、オブジェクトや配列を指定します。

<span id="validation-invalid-input"></span>

### 入力値が不正

**コード：** `VALIDATION_INVALID_INPUT`
**ステータス：** 400

PostgreSQLが入力を拒否しました。無効なJSON、数値や日付の形式、列の長さ、値の範囲など（SQLSTATEのクラス22）です。

**対処：** 列の型と値を確認してください。JSON列はJSONの値、数値・日付は正しい形式が必要です。

<span id="validation-column-not-found"></span>

### 列が見つからない

**コード：** `VALIDATION_COLUMN_NOT_FOUND`
**ステータス：** 400

対象のテーブルにない列を参照しています。

**対処：** manage_schemaのgetでスキーマを確認し、大文字・小文字も含めて列名を確認してください。

<span id="validation-table-not-found"></span>

### テーブルが見つからない

**コード：** `VALIDATION_TABLE_NOT_FOUND`
**ステータス：** 400

アプリのスキーマにないテーブルを参照しています。

**対処：** manage_schemaやダッシュボードで確認し、作成するか名前を修正してください。

<span id="validation-invalid-name"></span>

### 名前が不正

**コード：** `VALIDATION_INVALID_NAME`
**ステータス：** 400

テーブル、列、アプリ、関数などの名前が、文字、予約語、長さなどの規則に合いません。

**対処：** 小文字、数字、アンダースコアを使い、先頭は英字にします。SQLの予約語を避け、スキーマの命名規則を確認してください。

<span id="validation-constraint-violation"></span>

### 制約違反

**コード：** `VALIDATION_CONSTRAINT_VIOLATION`
**ステータス：** 400

データベースの制約に違反しましたが、以下の個別コードに分類できませんでした。

**対処：** details.constraint_detailsで制約名を確認し、本文を修正してください。

<span id="validation-unique-constraint-violation"></span>

### 一意制約違反

**コード：** `VALIDATION_UNIQUE_CONSTRAINT_VIOLATION`
**ステータス：** 409

追加・更新する値が、一意制約のある列で重複します。

**対処：** 別の値を使うか、既存の行を更新してください。

<span id="validation-foreign-key-violation"></span>

### 外部キー制約違反

**コード：** `VALIDATION_FOREIGN_KEY_VIOLATION`
**ステータス：** 400

外部キーの値が、参照先の行に一致しません。

**対処：** 親の行を先に作成するか、存在する行へ参照を修正してください。

<span id="validation-check-constraint-violation"></span>

### CHECK制約違反

**コード：** `VALIDATION_CHECK_CONSTRAINT_VIOLATION`
**ステータス：** 400

数値の範囲、正規表現など、CHECK制約に合いません。

**対処：** スキーマの制約を確認し、満たす値に変更してください。

<span id="validation-not-null-violation"></span>

### NOT NULL制約違反

**コード：** `VALIDATION_NOT_NULL_VIOLATION`
**ステータス：** 400

NULLを許可せず既定値もない列が、リクエストにありません。

**対処：** `details.column`に示された列に値を指定するか、スキーマに既定値（UUIDのgen_random_uuid()、日時のnow()など）を設定してください。

<span id="authentication--authorization-errors"></span>

## 認証と権限のエラー

未認証、権限不足、トークン不正です。通常は401 Unauthorizedか403 Forbiddenです。

<span id="auth-required"></span>

### 認証が必要

**コード：** `AUTH_REQUIRED`
**ステータス：** 401

認証が必要なエンドポイントへ、認証情報なしでアクセスしています。

**対処：** Authorization: Bearerヘッダーを指定します。サーバー間はサービスキー、ユーザー単位はエンドユーザーJWTを使います。

<span id="auth-invalid-token"></span>

### トークンが無効

**コード：** `AUTH_INVALID_TOKEN`
**ステータス：** 401

Bearerトークンの形式、署名キーなどが不正です。

**対処：** 対象アプリから発行した値で、変更されていないか確認し、必要なら再発行してください。

<span id="auth-invalid-api-key"></span>

### APIキーが無効

**コード：** `AUTH_INVALID_API_KEY`
**ステータス：** 401

bb_sk_...などのキーが、このアプリの登録済みキーに一致しないか、失効済みです。

**対処：** ダッシュボードのAPI Keysで確認し、必要なら新しいサービスキーを発行します。別アプリのキーは使えません。

<span id="auth-insufficient-permissions"></span>

### 権限不足

**コード：** `AUTH_INSUFFICIENT_PERMISSIONS`
**ステータス：** 403

認証済みですが、操作の権限がありません。公開用のキーでサービス専用APIを呼ぶ場合などです。

**対処：** 必要なスコープのある認証情報を使ってください。公開用キーはクライアント向けの操作に制限します。

<span id="auth-invalid-end-user-jwt"></span>

### エンドユーザーJWTが無効

**コード：** `AUTH_INVALID_END_USER_JWT`
**ステータス：** 401

JWTが不正、署名キーが異なる、またはアプリのユーザー認証が未設定です。

**対処：** アプリの有効なJWTか確認し、未設定ならOAuthなどの認証設定を行ってください。

<span id="auth-end-user-jwt-expired"></span>

### エンドユーザーJWTの期限切れ

**コード：** `AUTH_END_USER_JWT_EXPIRED`
**ステータス：** 401

ユーザーのセッショントークンが失効しています。

**対処：** 再ログインまたはセッションの更新後に再試行してください。

<span id="auth-rls-requires-user-jwt"></span>

### RLSにユーザーJWTが必要

**コード：** `AUTH_RLS_REQUIRES_USER_JWT`
**ステータス：** 401

対象のRLSでエンドユーザーの認証が必要ですが、サービスキーや匿名でアクセスしています。

**対処：** ユーザー単位のアクセスには認証フローで発行したJWTを使います。サービス用の許可はRLSポリシーで明示的に設定します。

<span id="auth-rls-policy-violation"></span>

### RLSポリシー違反

**コード：** `AUTH_RLS_POLICY_VIOLATION`
**ステータス：** 403

認証済みですが、対象のRLSがこの行や操作を許可していません。

**対処：** manage_rlsでポリシーを確認し、[RLSガイド](/ja/core-concepts/row-level-security/)で調査してください。

<span id="resource-errors"></span>

## リソースのエラー

対象が存在しない、または状態が競合しています。

<span id="resource-not-found"></span>

### リソースが見つからない

**コード：** `RESOURCE_NOT_FOUND`
**ステータス：** 404

アプリ、関数、デプロイ、ファイル、行などがないか、アクセスできません。

**対処：** IDと、manage_app・manage_functionなどのlistを確認してください。

<span id="app-not-found"></span>

### アプリが見つからない

**コード：** `APP_NOT_FOUND`
**ステータス：** 404

app_idがアクセス可能なアプリに一致しません。

**対処：** manage_appのlistやダッシュボードでIDを確認します。アプリIDはUUIDではなく短いスラッグです。

<span id="resource-already-exists"></span>

### リソースが既に存在

**コード：** `RESOURCE_ALREADY_EXISTS`
**ステータス：** 409

同じ識別子のリソースを再作成しようとしています。

**対処：** 既存のものを使う、識別子を変える、または更新してください。

<span id="resource-conflict"></span>

### リソースの競合

**コード：** `RESOURCE_CONFLICT`
**ステータス：** 409

同時変更や対象の状態の不整合により実行できません。

**対処：** 再取得して最新の状態で再試行してください。

<span id="quota-errors"></span>

## 利用枠のエラー

プランやリソースの上限に達しました。通常は402 Payment Requiredや429 Too Many Requestsです。

<span id="quota-storage-exceeded"></span>

### ストレージの上限

**コード：** `QUOTA_STORAGE_EXCEEDED`
**ステータス：** 402

ストレージの容量を使い切り、追加のアップロードを拒否しました。

**対処：** 不要なファイルを削除するかプランを変更します。使用量と上限はdetailsで確認できます。

<span id="quota-file-size-exceeded"></span>

### ファイルサイズの上限

**コード：** `QUOTA_FILE_SIZE_EXCEEDED`
**ステータス：** 413

1ファイルのサイズが、ストレージやプランの設定を超えています。

**対処：** 分割、圧縮、プランの変更を検討します。上限はエラーに含めます。

<span id="quota-storage-error"></span>

### ストレージの利用枠確認エラー

**コード：** `QUOTA_STORAGE_ERROR`
**ステータス：** 500

利用枠の確認中に内部エラーが発生しました。

**対処：** 再試行し、続く場合はサポートへ連絡してください。実際の容量超過ではなく、一時的な問題の場合があります。

<span id="quota-rate-limit"></span>

### レート制限

**コード：** `QUOTA_RATE_LIMIT`
**ステータス：** 429

エンドポイントやアプリのリクエスト上限を超えています。

**対処：** Retry-Afterの時間を待って再試行します。可能なら一括処理で通信を減らしてください。

<span id="quota-table-limit"></span>

### テーブル数の上限

**コード：** `QUOTA_TABLE_LIMIT`
**ステータス：** 402

プランのテーブル数上限に達しました。

**対処：** 不要なテーブルの整理やプラン変更を検討します。[プランと使用量](/ja/core-concepts/plans-and-usage/)を参照してください。

<span id="quota-deployment-limit"></span>

### デプロイ数の上限

**コード：** `QUOTA_DEPLOYMENT_LIMIT`
**ステータス：** 402

プランのフロントエンドまたは関数のデプロイ数上限に達しました。

**対処：** 不要なデプロイを対応する管理APIで削除するか、プランを変更してください。アプリ全体の削除とは区別してください。

<span id="state-errors"></span>

## 状態のエラー

リソースは存在しますが、現在の状態では操作できません。

<span id="state-invalid-transition"></span>

### 状態の変更が不正

**コード：** `STATE_INVALID_TRANSITION`
**ステータス：** 409

現在の状態から指定の状態へ移れません。停止していないアプリの再開などです。

**対処：** detailsの実際の状態と期待する状態を確認し、対応する操作を行ってください。

<span id="state-prerequisite-missing"></span>

### 前提条件の不足

**コード：** `STATE_PREREQUISITE_MISSING`
**ステータス：** 409

スキーマ未初期化での関数デプロイなど、必要なリソースや設定がありません。

**対処：** remediationの前提手順を完了してから再試行してください。

<span id="app-paused"></span>

### アプリが一時停止中

**コード：** `APP_PAUSED`
**ステータス：** 423

再開までデータやランタイムのAPIを利用できません。

**対処：** 再開の操作やダッシュボードで有効化してください。停止中もストレージの料金は発生します。

<span id="schema-errors"></span>

## スキーマのエラー

<span id="schema-destructive-change"></span>

### 破壊的な変更

**コード：** `SCHEMA_DESTRUCTIVE_CHANGE`
**ステータス：** 400

データのある列やテーブルの削除に、明示的な確認がありません。

**対処：** バックアップしてから確認フラグを付けるか、列の追加などの変更へ設計し直してください。

<span id="schema-migration-failed"></span>

### マイグレーション失敗

**コード：** `SCHEMA_MIGRATION_FAILED`
**ステータス：** 500

実行中にPostgreSQLが拒否しました。

**対処：** detailsのSQLエラーを確認します。既定値なしのNOT NULL、存在しない参照、変換できない型などが原因です。

<span id="rls-errors"></span>

## RLSのエラー

<span id="rls-unsafe-expression"></span>

### 安全でない式

**コード：** `RLS_UNSAFE_EXPRESSION`
**ステータス：** 400

更新するサブクエリ、許可されない関数や型変換などを含みます。

**対処：** [RLSガイド](/ja/core-concepts/row-level-security/)の許可された式で書き直してください。

<span id="realtime-errors"></span>

## リアルタイムのエラー

<span id="realtime-not-configured"></span>

### リアルタイム未設定

**コード：** `REALTIME_NOT_CONFIGURED`
**ステータス：** 400

アプリまたは対象のテーブルで有効化していません。

**対処：** manage_realtimeでテーブルごとに有効化してから購読します。

<span id="realtime-connection-limit"></span>

### 接続数の上限

**コード：** `REALTIME_CONNECTION_LIMIT`
**ステータス：** 429

同時接続の上限に達しました。

**対処：** 未使用の接続を閉じる、共有する、プランを変更する方法を検討します。

<span id="function-errors"></span>

## 関数のエラー

<span id="function-timeout"></span>

### 関数のタイムアウト

**コード：** `FUNCTION_TIMEOUT`
**ステータス：** 504

実行時間の上限を超えました。

**対処：** 処理を改善するか長時間の処理を別ジョブに分けます。[関数](/ja/core-concepts/functions/)で上限を確認してください。

<span id="integration-errors"></span>

## 外部連携のエラー

<span id="integrations-not-configured"></span>

### 連携未設定

**コード：** `INTEGRATIONS_NOT_CONFIGURED`
**ステータス：** 400

アプリに連携機能を設定していません。

**対処：** manage_integrationsのconfigureで有効化し、ツールキットを接続します。

<span id="integrations-toolkit-not-enabled"></span>

### ツールキット無効

**コード：** `INTEGRATIONS_TOOLKIT_NOT_ENABLED`
**ステータス：** 400

slackやgithubなどのツールキットを有効にしていません。

**対処：** manage_integrationsのconfigureで設定してから実行します。

<span id="integrations-not-connected"></span>

### アカウント未接続

**コード：** `INTEGRATIONS_NOT_CONNECTED`
**ステータス：** 400

エンドユーザーの有効な接続アカウントがありません。

**対処：** ユーザーのOAuth接続フローを完了してから再試行します。

<span id="integrations-connection-expired"></span>

### 接続の期限切れ

**コード：** `INTEGRATIONS_CONNECTION_EXPIRED`
**ステータス：** 401

認証情報が期限切れで、更新にも失敗しました。

**対処：** 再度ユーザーのOAuth同意フローを行ってください。

<span id="integrations-execution-failed"></span>

### 実行失敗

**コード：** `INTEGRATIONS_EXECUTION_FAILED`
**ステータス：** 502

接続先のツールがエラーを返しました。

**対処：** detailsでプロバイダーの応答を確認します。引数、スコープ、レート制限などが原因です。

<span id="integrations-quota-exceeded"></span>

### 連携の利用枠超過

**コード：** `INTEGRATIONS_QUOTA_EXCEEDED`
**ステータス：** 429

アプリまたはユーザーの実行枠を使い切りました。

**対処：** リセットを待つかプランを変更します。

<span id="external-system-errors"></span>

## 外部システムのエラー

S3、Cloudflare、データベース、通信先などのエラーです。

<span id="s3-error"></span>

### S3エラー

**コード：** `S3_ERROR`
**ステータス：** 502

S3互換ストレージの予期しないエラーです。

**対処：** 間隔を延ばして再試行し、続く場合はサポートへ連絡してください。

<span id="external-s3-error"></span>

### オブジェクトストレージのエラー

**コード：** `EXTERNAL_S3_ERROR`
**ステータス：** 502

通信、署名、サービス停止などでプロバイダーへのリクエストが失敗しました。

**対処：** 再試行し、続く場合はdetailsのリクエストIDを保存して連絡してください。

<span id="external-db-error"></span>

### データベースのエラー

**コード：** `EXTERNAL_DB_ERROR`
**ステータス：** 502

制約や検証に分類できないPostgreSQLのエラーです。

**対処：** 1回再試行し、続く場合は障害情報やサポートを確認します。

<span id="external-network-error"></span>

### ネットワークのエラー

**コード：** `EXTERNAL_NETWORK_ERROR`
**ステータス：** 502

DNS、接続、通信などのエラーで外部呼び出しが失敗しました。

**対処：** 間隔を空けて再試行します。自分のWebhookなどの場合は稼働状況とTLSも確認してください。

<span id="external-cloudflare-error"></span>

### Cloudflareのエラー

**コード：** `EXTERNAL_CLOUDFLARE_ERROR`
**ステータス：** 502

Workers、Pages、R2、Durable ObjectsなどのAPIが失敗しました。

**対処：** detailsのコードを確認します。一時的なものと、アカウントやプランの変更が必要なものがあります。

<span id="internal-errors"></span>

## 内部エラー

<span id="internal-error"></span>

### 内部エラー

**コード：** `INTERNAL_ERROR`
**ステータス：** 500

個別のコードに分類できない、予期しない内部エラーです。

**対処：** 再試行し、再現する場合は応答本文とリクエストID（ある場合）を記録してサポートへ連絡してください。
