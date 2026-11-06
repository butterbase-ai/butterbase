---
title: REST API
description: 自動生成されるデータAPI、フィルター、並べ替え、ページ分割のREST APIリファレンス。
---

スキーマツールでテーブルを作成すると、REST APIを自動で利用できます。コード生成や経路設定は不要です。

**プレースホルダー：**
- `{app_id}` — アプリの識別子
- `{table}` — スキーマのテーブル名
- `{id}` — 行の主キーの値

<span id="data-api"></span>

## データAPI

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/\{table} | フィルター、並べ替え、ページ分割付きで行を一覧取得 |
| GET | /v1/\{app_id}/\{table}/\{id} | 主キーで1行取得 |
| POST | /v1/\{app_id}/\{table} | 行を作成 |
| PATCH | /v1/\{app_id}/\{table}/\{id} | 行を部分更新 |
| DELETE | /v1/\{app_id}/\{table}/\{id} | 行を削除 |

<span id="filtering"></span>

## フィルター

`column=operator.value`形式のクエリパラメーターを追加します。

| 演算子 | 例 | 意味 |
|----------|---------|---------|
| `eq` | `status=eq.published` | 等しい |
| `neq` | `status=neq.draft` | 等しくない |
| `gt` | `age=gt.18` | より大きい |
| `gte` | `age=gte.18` | 以上 |
| `lt` | `price=lt.100` | より小さい |
| `lte` | `price=lte.100` | 以下 |
| `like` | `title=like.%hello%` | パターン一致（大文字・小文字を区別） |
| `ilike` | `title=ilike.%hello%` | パターン一致（大文字・小文字を区別しない） |
| `is` | `deleted_at=is.null` | IS NULL、IS TRUE、IS FALSE |
| `in` | `id=in.(1,2,3)` | 値のリストに含まれる |
| `fts` | `title=fts.hello world` | 全文検索（英語、語幹処理あり） |

<span id="sorting"></span>

## 並べ替え

`order`パラメーターを使います。

```
?order=created_at.desc
?order=name.asc,created_at.desc
```

<span id="pagination"></span>

## ページ分割

`limit`と`offset`を使います。

```
?limit=20&offset=40
```

41〜60行目を返します。

<span id="column-selection"></span>

## 取得列の指定

`select`パラメーターを使います。

```
?select=id,title,created_at
```

<span id="example"></span>

## 例

```
GET /v1/{app_id}/posts?select=id,title,author_id&status=eq.published&order=created_at.desc&limit=20
```

<span id="authentication"></span>

## 認証

Authorizationヘッダーからロールを自動判定します。

| リクエストの種類 | Authorizationヘッダー | ロール |
|---|---|---|
| 認証ヘッダーなし | なし | butterbase_anon |
| エンドユーザーJWT | `Bearer {jwt}` | butterbase_user |
| プラットフォームAPIキー | `Bearer {api_key}` | butterbase_service |

各ロールとデータへのアクセス制御については[行レベルセキュリティ](/ja/core-concepts/row-level-security)を参照してください。

<span id="schema-endpoints"></span>

## スキーマのエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\{app_id}/schema | 現在のスキーマを取得 |
| POST | /v1/\{app_id}/schema/apply | スキーマ更新を適用 |
| GET | /v1/\{app_id}/migrations | 適用済みマイグレーションを一覧取得 |

<span id="app-management"></span>

## アプリ管理

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /apps | 自分のアプリを一覧取得 |
| POST | /init | アプリを作成（`region`は任意） |
| DELETE | /apps/\{app_id} | アプリを削除 |
| GET | /v1/regions | 対応リージョンを一覧取得（公開、認証不要） |
| POST | /v1/apps/\{app_id}/move | アプリを別リージョンへ移動 |
| GET | /v1/apps/\{app_id}/migrations/\{migration_id} | 移動の進捗を確認 |

リクエストとレスポンスの形は[リージョン](/ja/core-concepts/regions/)と[プラットフォームAPI](/ja/api-reference/platform-api/#apps--regions)を参照してください。

<span id="health-checks"></span>

## ヘルスチェック

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /health | 生存確認 |
| GET | /health/ready | 準備状態の確認（データベースも検証） |

<span id="error-responses"></span>

## エラーレスポンス

エラーには`code`、`message`、`remediation`を含む構造化オブジェクトが返ります。

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Table 'nonexistent' does not exist",
    "remediation": "Check the table name and ensure it exists in your schema"
  }
}
```

全エンドポイントは[APIリファレンス](/ja/api-reference/data-api)を参照してください。
