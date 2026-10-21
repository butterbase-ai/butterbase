---
title: データAPI
description: 自動生成されるCRUD REST APIのリファレンス。
sidebar:
  order: 1
---

スキーマにテーブルが存在すると、以下のエンドポイントを自動で利用できます。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/\{table} | 行を一覧取得 |
| GET | /v1/\{app_id}/\{table}/\{id} | 1行を取得 |
| POST | /v1/\{app_id}/\{table} | 行を作成 |
| PATCH | /v1/\{app_id}/\{table}/\{id} | 行を更新 |
| DELETE | /v1/\{app_id}/\{table}/\{id} | 行を削除 |

<span id="query-parameters"></span>

## クエリパラメーター

<span id="filtering"></span>

### フィルター

形式：`column=operator.value`

| 演算子 | 例 | SQL |
|----------|---------|-----|
| `eq` | `status=eq.published` | `= 'published'` |
| `neq` | `status=neq.draft` | `!= 'draft'` |
| `gt` | `age=gt.18` | `> 18` |
| `gte` | `age=gte.18` | `>= 18` |
| `lt` | `price=lt.100` | `< 100` |
| `lte` | `price=lte.100` | `<= 100` |
| `like` | `title=like.%hello%` | `LIKE '%hello%'` |
| `ilike` | `title=ilike.%hello%` | `ILIKE '%hello%'` |
| `is` | `deleted_at=is.null` | `IS NULL` |
| `in` | `id=in.(1,2,3)` | `IN (1,2,3)` |
| `fts` | `title=fts.hello` | 全文検索 |

<span id="sorting"></span>

### 並べ替え

```
?order=created_at.desc
?order=name.asc,created_at.desc
```

<span id="pagination"></span>

### ページ分割

```
?limit=20&offset=40
```

<span id="column-selection"></span>

### 取得列の指定

```
?select=id,title,created_at
```

<span id="authentication"></span>

## 認証

| 認証方法 | ロール | アクセス範囲 |
|---|---|---|
| なし | butterbase_anon | 公開データのみ |
| エンドユーザーJWT | butterbase_user | ユーザー単位のデータ（RLS） |
| APIキー（`bb_sk_...`） | butterbase_service | 全データ（RLSをバイパス） |

<span id="create-a-row"></span>

## 行の作成

```bash
POST /v1/{app_id}/posts
Content-Type: application/json
Authorization: Bearer {token}

{
  "title": "Hello World",
  "body": "My first post",
  "published": true
}
```

ユーザー分離ポリシーと自動入力トリガーがある場合、`user_id`列を自動で設定します。

<span id="update-a-row"></span>

## 行の更新

```bash
PATCH /v1/{app_id}/posts/{id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "published": false
}
```

変更する列だけを送ってください。

<span id="delete-a-row"></span>

## 行の削除

```bash
DELETE /v1/{app_id}/posts/{id}
Authorization: Bearer {token}
```

<span id="schema-endpoints"></span>

## スキーマのエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/schema | 現在のスキーマを取得 |
| POST | /v1/\{app_id}/schema/apply | スキーマ更新を適用（`dry_run: true`で事前確認） |
| GET | /v1/\{app_id}/migrations | 適用済みマイグレーションを一覧取得 |

<span id="app-management"></span>

## アプリ管理

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /apps | 自分のアプリを一覧取得 |
| POST | /init | アプリを作成。本文：`{"name": "my-app"}` |
| DELETE | /apps/\{app_id} | アプリを完全に削除 |
