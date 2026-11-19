---
title: データベースとスキーマ
description: JSONで望むスキーマを定義し、必要な差分だけを適用します。
---

宣言的なJSONでデータベースを定義します。望む状態を記述すると、必要な変更を計算して適用します。

作成時に選んだ[リージョン](/ja/core-concepts/regions/)に保存します。利用者の地域が変われば後から移動できます。

<span id="basic-structure"></span>

## 基本構造

```json
{
  "schema": {
    "tables": {
      "table_name": {
        "columns": {
          "column_name": {
            "type": "text",
            "primary": true,
            "nullable": false,
            "unique": true,
            "default": "gen_random_uuid()",
            "references": { "table": "other_table", "column": "id" }
          }
        },
        "indexes": {
          "idx_name": {
            "columns": ["col1", "col2"],
            "unique": false
          }
        }
      }
    }
  },
  "dry_run": false,
  "name": "descriptive migration name"
}
```

<span id="column-properties"></span>

## 列の属性

| 属性 | 型 | 必須 | 説明 |
|----------|------|----------|-------------|
| `type` | string | はい | 列のデータ型 |
| `primary` | boolean | いいえ | 主キーにする |
| `nullable` | boolean | いいえ | NULLを許可（既定true） |
| `unique` | boolean | いいえ | 一意制約を追加 |
| `default` | string | いいえ | 既定値の式（now()、gen_random_uuid()など） |
| `references` | string \| object | いいえ | 外部キー。table.columnか`{table, column, onDelete?, onUpdate?}`。 |

<span id="supported-column-types"></span>

## 対応する型

| 分類 | 型 |
|----------|-------|
| **文字列** | `text`、`varchar`、`varchar(N)`、`char`、`char(N)` |
| **数値** | `integer`、`bigint`、`smallint`、`real`、`float4`、`float8`、`decimal`、`numeric`、`numeric(P,S)` |
| **真偽値** | `boolean`、`bool` |
| **UUID** | `uuid` |
| **日時** | `timestamp`、`timestamptz`、`date`、`time`、`timetz`、`interval` |
| **JSON** | `json`, `jsonb` |
| **バイナリ** | `bytea` |
| **ベクトル** | `vector(N)`。Nは次元数（AI埋め込み用） |
| **配列** | `text[]`、`integer[]`など |

<span id="common-patterns"></span>

## よく使うパターン

<span id="basic-table-with-auto-generated-id"></span>

### 自動IDの基本テーブル

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

<span id="table-with-foreign-key-and-user-ownership"></span>

### 外部キーとユーザー所有権

```json
{
  "tables": {
    "comments": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "post_id": { "type": "uuid", "nullable": false, "references": { "table": "posts", "column": "id", "onDelete": "CASCADE" } },
        "user_id": { "type": "uuid", "nullable": false },
        "body": { "type": "text", "nullable": false },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "indexes": {
        "idx_comments_post": { "columns": ["post_id"] },
        "idx_comments_user": { "columns": ["user_id"] }
      }
    }
  }
}
```

作成後、manage_rlsにcreate_user_isolation、table_name: comments、user_column: user_idを指定してユーザー単位で分離します。

<span id="foreign-keys-with-referential-actions"></span>

### 外部キーの参照アクション

referencesは同等の2形式を受け付けます。

**文字列** — onDeleteとonUpdateはNO ACTIONになります。

```json
"author_id": { "type": "uuid", "references": "users.id" }
```

**オブジェクト** — アクションを明示できます。

```json
"author_id": {
  "type": "uuid",
  "references": {
    "table": "users",
    "column": "id",
    "onDelete": "CASCADE",
    "onUpdate": "NO ACTION"
  }
}
```

**onDelete・onUpdateに指定する値：**

| 値 | 参照行を削除・更新したときの動作 |
|-------|---------------------------------------------------|
| `NO ACTION`（既定） | 依存行があれば拒否（遅延評価可） |
| `RESTRICT` | 遅延せず即座に拒否 |
| `CASCADE` | 依存行にも同じ操作を適用 |
| `SET NULL` | 外部キーをNULLにする（nullableが必要） |
| `SET DEFAULT` | 宣言した既定値へ変更 |

ユーザー削除で投稿も削除する例：

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "author_id": {
          "type": "uuid",
          "nullable": false,
          "references": { "table": "users", "column": "id", "onDelete": "CASCADE" }
        },
        "title": { "type": "text", "nullable": false }
      }
    }
  }
}
```

<span id="table-with-vector-column-for-ai-embeddings"></span>

### ベクトル列（AI埋め込み）

```json
{
  "tables": {
    "documents": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "content": { "type": "text" },
        "embedding": { "type": "vector(1536)" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

<span id="adding-columns-to-existing-tables"></span>

## 既存テーブルへの列追加

既存列と新しい列を含めて定義します。差分だけを適用します。

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "image_url": { "type": "text" },
        "view_count": { "type": "integer", "default": "0" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

既存列を変えずimage_urlとview_countを追加します。

<span id="dropping-columns"></span>

## 列の削除

_dropColumnsへ削除する列を明示します。

```json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "_dropColumns": ["published", "image_url"]
    }
  }
}
```

<span id="dropping-tables"></span>

## テーブル削除

_drop: trueでテーブル全体を削除します。

```json
{
  "tables": {
    "old_table": {
      "_drop": true
    }
  }
}
```

<span id="marking-tables-as-seed-data"></span>

## シードデータの指定

_seed: trueを指定すると、テンプレートの複製時に行もコピーします。

```json
{
  "tables": {
    "roles": {
      "_seed": true,
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "name": { "type": "text", "nullable": false, "unique": true },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

適用・取得の繰り返しでも指定は保持します。参照テーブル、既定ロール、例示用の行などに使い、複製先に必要な初期データを用意します。

シード指定の行を新DBへコピーします。未指定はスキーマだけで、行はコピーしません。

<span id="what-a-clone-copies"></span>

## 複製する内容

新しいアプリへ次をコピーします。

- スキーマ（テーブル、列、インデックス）
- RLSポリシー
- 関数コード
- 複製時点の最新ファイル
- シークレット以外の設定（ストレージ、CORS、OAuthの種類・URL、AIモデル）
- _seed: trueの行
- 最新フロントエンド。IDを新しいアプリへ置換（未公開なら省略、失敗時は警告）

<span id="what-stays-with-you"></span>

## 元のアプリに残るもの

次は引き継ぎません。

- ユーザーアカウントとセッション
- OAuthのクライアント認証情報
- 関数の環境変数の値
- BYOK AIキー
- カスタムドメイン
- 課金設定
- 呼び出し履歴
- 監査ログ

完了後に新しい所有者が設定します。[複製先の設定](/ja/templates/configure/)を参照してください。

<span id="clone-regions"></span>

## 複製先のリージョン

[対応リージョン](/ja/core-concepts/regions/)から選べます。地域をまたぐ場合、ファイルの転送で少し長くかかることがあります。

<span id="dry-run-preview-changes"></span>

## Dry run（変更の事前確認）

破壊的な変更は先に確認してください。

```json
{
  "schema": { "tables": { "..." : {} } },
  "dry_run": true
}
```

実行せずSQLを返します。確認後にdry_run: falseか省略で適用します。

<span id="auto-generated-data-api"></span>

## 自動生成するデータAPI

テーブルが存在すればREST APIを利用できます。コード生成は不要です。[REST API](/ja/sdks-and-tools/rest-api)を参照してください。

<span id="safety"></span>

## 安全性

- **削除は既定で拒否。** _dropや_dropColumnsを明示してください。
- **定義の上限：** 50テーブル。
- **冪等：** 同じ定義の再適用では変更せず、差分だけ処理。

<span id="database-architecture"></span>

## データベース構成

データプレーンに専用のPostgreSQL（app_{id}）を用意し、次を初期設定します。

- 埋め込み用pgvector
- UUID用uuid-ossp
- RLS用current_user_id()
- マイグレーションの履歴
