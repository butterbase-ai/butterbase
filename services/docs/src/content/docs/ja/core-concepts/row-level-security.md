---
title: 行レベルセキュリティ
description: PostgreSQLのRLSポリシーで、各ユーザーがアクセスできる行を制御します。
---

行レベルセキュリティ（RLS）は、ユーザーがアクセスできる行を制御します。PostgreSQL内蔵の仕組みを使い、リクエストの認証方式に応じて自動適用します。

<span id="built-in-roles"></span>

## 組み込みロール

Authorizationヘッダーで**自動判定**するロールが3つあります。自分で作成・設定する必要はありません。

| リクエストの種類 | Authorizationヘッダー | 割り当てるロール |
|---|---|---|
| 認証ヘッダーなし | なし | butterbase_anon |
| エンドユーザーJWT | `Bearer {end_user_jwt}` | butterbase_user |
| プラットフォームAPIキー | `Bearer {platform_api_key}` | butterbase_service |

**butterbase_anon** — ポリシーで許可した公開データだけにアクセスします。商品一覧や公開プロフィールに使います。

**butterbase_user** — ユーザー固有データにアクセスします。`current_user_id()`は認証済みユーザーIDを返し、ダッシュボードや個人データに使います。

**butterbase_service** — 全データへのアクセスを許可します。RLSを有効にした各テーブルにサービス用の許可ポリシーを自動作成します。

<span id="one-tool-three-common-actions"></span>

## 1つのツールで行う3つの主な操作

`manage_rls`の`action`で全RLS操作を選びます（`enable`、`create_policy`、`update_policy`、`create_user_isolation`、`list`、`delete`）。

<span id="1-enable--foundation"></span>

### 1. enable — 基本設定

テーブルでRLSを有効にし、サービス用許可ポリシーを自動作成します。

```
manage_rls({ action: "enable", app_id: "app_abc123", table_name: "posts" })
```

<span id="2-create_user_isolation--simple"></span>

### 2. create_user_isolation — 簡単な分離

1回で、ユーザーが自分のデータだけを見る設定を行います。

```
manage_rls({
  action: "create_user_isolation",
  app_id: "app_abc123",
  table_name: "posts",
  user_column: "user_id"
})
```

自動で次を設定します。
- RLSを有効化
- butterbase_userに限定したユーザー分離ポリシー
- INSERT時にユーザー列を自動設定するトリガー
- サービス用許可ポリシー

<span id="3-create_policy--power-user"></span>

### 3. create_policy — 詳細な制御

USINGとWITH CHECK式を自由に設定できます。

```
manage_rls({
  action: "create_policy",
  app_id: "app_abc123",
  table_name: "products",
  policy_name: "public_read_products",
  command: "SELECT",
  role: "anon",
  using_expression: "active = true AND published = true"
})
```

**コマンドごとの式：**

| コマンド | USING | WITH CHECK |
|---------|-------|------------|
| SELECT | 必要 | 不要 |
| INSERT | 不要 | 必要 |
| UPDATE | 両方 | 両方 |
| DELETE | 必要 | 不要 |
| ALL | 両方 | 両方 |

<span id="policy-examples"></span>

## ポリシーの例

<span id="public-read-access-anonymous-users"></span>

### 公開読み取り（匿名ユーザー）

```
manage_rls({
  action: "create_policy",
  policy_name: "public_read_products",
  command: "SELECT",
  role: "anon",
  using_expression: "active = true AND published = true"
})
```

<span id="user-specific-access-authenticated-users"></span>

### ユーザー固有のアクセス（認証済み）

簡単な方法：
```
manage_rls({
  action: "create_user_isolation",
  table_name: "orders",
  user_column: "user_id"
})
```

独自に定義する方法：
```
manage_rls({
  action: "create_policy",
  policy_name: "users_own_orders",
  command: "ALL",
  role: "user",
  using_expression: "user_id = current_user_id()"
})
```

<span id="insert-policy-user-can-only-insert-their-own-rows"></span>

### INSERTポリシー（自分の行だけ作成）

```
manage_rls({
  action: "create_policy",
  policy_name: "users_insert_own",
  command: "INSERT",
  role: "user",
  with_check_expression: "user_id = current_user_id()::uuid"
})
```

<span id="mixed-access-public-read-user-write"></span>

### 公開読み取りとユーザー書き込み

1. RLSを有効化：`manage_rls({ action: "enable", table_name: "products" })`
2. 公開読み取り：`manage_rls({ action: "create_policy", command: "SELECT", role: "anon", using_expression: "active = true" })`
3. 認証済みの書き込み：`manage_rls({ action: "create_policy", command: "INSERT", role: "user", with_check_expression: "user_id = current_user_id()" })`

<span id="role-scoping"></span>

## ロールの限定

意図しないロールにポリシーを適用しないよう、必ず`role`を指定します。
- `role: "anon"` — 未認証リクエストだけに適用
- `role: "user"` — 認証済みエンドユーザーだけに適用

限定しないと全ロールへ適用し、意図せずデータを公開する可能性があります。

<span id="helper-functions"></span>

## 補助関数

- **current_user_id()** — 認証済みユーザーIDをTEXTで返します。必要なら`current_user_id()::uuid`へ変換します。匿名ユーザーではNULLです。

<span id="auto-populate-trigger"></span>

## 自動入力トリガー

`create_user_isolation`、または`user_column`を指定した`create_policy`だけが、ユーザー列を埋めるBEFORE INSERTトリガーを作ります。トリガーがなければクライアントのPOST本文にユーザー列を含めてください。

<span id="common-pitfall-cross-table-subqueries"></span>

## よくある問題：別テーブルのサブクエリ

USING・WITH CHECKのどちらでも、許可・制限のどちらでも、`EXISTS (SELECT 1 FROM other_table WHERE …)`や`column IN (SELECT … FROM other_table)`を含む式は、同じ呼び出しロールで**参照先テーブル自身のRLS**を通して読みます。対象行が見えなければ、外側の式もfalseになり、書き込みは`AUTH_RLS_POLICY_VIOLATION`、読み取りは空になります。一見trueになる式でも同じです。

主な原因は3つあります。

<span id="1-referenced-table-has-rls-enabled-but-no-permissive-user-policy"></span>

### 1. 参照先でRLSが有効だがuser向け許可がない

RLSが有効なテーブルでは、明示的な許可がなければ`butterbase_user`からは0行に見えます。実在するUUIDを使った`EXISTS (SELECT 1 FROM institutions WHERE id = '<real uuid>')`もfalseになります。

対処：サブクエリに必要な行への読み取りを許可します。

```
manage_rls({
  action: "create_policy",
  table_name: "institutions",
  policy_name: "institutions_user_read",
  command: "SELECT",
  role: "user",
  using_expression: "true"   // or a narrower predicate
})
```

<span id="2-referenced-table-has-user_isolation--cross-user-reads-blocked"></span>

### 2. 参照先のユーザー分離で他人の行が見えない

ユーザーBがAの公開投稿へコメントする例では、commentsのポリシーが`EXISTS (SELECT 1 FROM posts WHERE id = post_id AND is_public = true)`を確認します。しかしpostsがユーザー分離されていると、BからAの行が見えずINSERTが拒否されます。

対処：参照先で`create_user_isolation`に`public_read_column: "is_public"`を指定するか、公開行に限定したSELECT許可ポリシーを追加します。

<span id="3-subquery-joins-on-a-column-different-from-the-isolation-column"></span>

### 3. 参照する列とユーザー分離の列が違う

usersを`id = current_user_id()::uuid`で分離していて、セッションのsubが別のauth_user_id（OAuthコールバックで独自IDを生成する場合など）だとします。checkpointsのポリシーが`EXISTS (SELECT 1 FROM users WHERE u.id = checkpoints.student_id AND u.auth_user_id = current_user_id()::uuid)`を確認しても、先にidで絞られた行のauth_user_idは一致せず、結果が空になります。

対処：参照先の分離列をセッションIDの対応先と合わせます。subがOAuthのauth_user_idなら次を実行します。

```
manage_rls({
  action: "create_user_isolation",
  table_name: "users",
  user_column: "auth_user_id"   // not "id"
})
```

<span id="quick-diagnosis"></span>

### 簡単な診断

通るはずのINSERTで`AUTH_RLS_POLICY_VIOLATION`が出たら、同じユーザーとして参照先にサブクエリ部分を実行します（`select_rows`に`as_role: "user", as_user: <uuid>`を指定）。0行なら、WITH CHECKの不具合ではなく、参照先のポリシーが原因です。

## REST API

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/rls/enable | RLSを有効化 |
| POST | /v1/\{app_id}/rls/policies | 独自ポリシーを作成 |
| POST | /v1/\{app_id}/rls | ユーザー分離を設定 |
| GET | /v1/\{app_id}/rls | 全ポリシーを一覧取得 |
| DELETE | /v1/\{app_id}/rls/\{table} | RLSを無効化 |
