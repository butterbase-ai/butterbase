---
title: RAG API
description: Butterbase標準のRAGのコレクション、文書取り込み、意味検索APIを説明します。
sidebar:
  order: 9
---

RAGのエンドポイントはすべて`/v1/{app_id}/rag/`配下です。認証には`Authorization: Bearer {service_key_or_jwt}`を指定します。

概要とSDKの使用例は[RAG（標準機能）](/ja/core-concepts/rag)を参照してください。

<span id="collections"></span>

## コレクション

<span id="create-collection"></span>

### コレクションの作成

```
POST /v1/{app_id}/rag/collections
```

**リクエスト本文：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `name` | string | はい | 小文字の英数字、ハイフン、アンダースコア |
| `description` | string | いいえ | 人が読むための説明 |
| `accessMode` | `private` \| `shared` \| `custom` | いいえ | 既定値：`private` |
| `chunkSize` | number | いいえ | チャンクあたりの文字数。既定値：512 |
| `chunkOverlap` | number | いいえ | チャンク間で重ねる文字数。既定値：64 |

**応答：** `Collection`オブジェクト（201）。

---

<span id="list-collections"></span>

### コレクション一覧の取得

```
GET /v1/{app_id}/rag/collections
```

**応答：** `Collection`オブジェクトの配列。

---

<span id="get-collection"></span>

### コレクションの取得

```
GET /v1/{app_id}/rag/collections/{name}
```

文書数とチャンク数を含むコレクションの詳細を返します。

**応答：** `CollectionDetails`オブジェクト。

---

<span id="delete-collection"></span>

### コレクションの削除

```
DELETE /v1/{app_id}/rag/collections/{name}
```

コレクションと、その文書・チャンク・埋め込みをすべて完全に削除します。元に戻せません。

**応答：** `204 No Content`。

---

<span id="documents"></span>

## 文書

<span id="ingest-document"></span>

### 文書の取り込み

```
POST /v1/{app_id}/rag/collections/{name}/ingest
```

非同期処理のキューへ文書を追加します。`status: "pending"`をすぐに返します。

**リクエスト本文（テキスト）：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `text` | string | はい* | 取り込むテキストの内容 |
| `filename` | string | いいえ | 文書の表示名 |
| `metadata` | object | いいえ | 各チャンクに保存する任意のキーと値のメタデータ |

**リクエスト本文（ストレージのファイル）：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `storage_object_id` | string | はい* | ストレージのアップロードAPIが返すオブジェクトID |
| `filename` | string | いいえ | 表示名を上書き |
| `metadata` | object | いいえ | 任意のキーと値のメタデータ |

*`text`または`storage_object_id`のいずれかが必須です。

**応答：** `IngestResult`オブジェクト（202）。

```json
{
  "documentId": "uuid",
  "status": "pending",
  "message": "Document queued for processing"
}
```

---

<span id="list-documents"></span>

### 文書一覧の取得

```
GET /v1/{app_id}/rag/collections/{name}/documents
```

**応答：** `RagDocument`オブジェクトの配列。

---

<span id="get-document"></span>

### 文書の取得

```
GET /v1/{app_id}/rag/collections/{name}/documents/{document_id}
```

文書の状態とメタデータを返します。`status`が`ready`または`failed`になるまでポーリングできます。

**応答：** `RagDocument`オブジェクト。

---

<span id="delete-document"></span>

### 文書の削除

```
DELETE /v1/{app_id}/rag/collections/{name}/documents/{document_id}
```

文書と、そのベクトルチャンクをすべて削除します。元に戻せません。

**応答：** `204 No Content`。

---

<span id="query"></span>

## クエリ

<span id="semantic-query"></span>

### 意味検索

```
POST /v1/{app_id}/rag/collections/{name}/query
```

**リクエスト本文：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `query` | string | はい | 自然言語の質問 |
| `topK` | number | いいえ | 取得するチャンクの件数。既定値：5 |
| `threshold` | number | いいえ | コサイン類似度の下限（0〜1）。下限未満のチャンクは除外します。 |
| `synthesize` | boolean | いいえ | 取得したチャンクからAIの回答を生成します。既定値：false |
| `model` | string | いいえ | 回答生成に使うモデル（例：`anthropic/claude-haiku-4-5`）。省略すると自動選択します。 |
| `filter` | object | いいえ | メタデータのフィルター（キーと値の組）。一致するチャンクだけを返します。 |

**応答：** `synthesize: false`の場合は`QueryResult`、`synthesize: true`の場合は`SynthesizedQueryResult`。

---

<span id="response-schemas"></span>

## 応答スキーマ

### Collection

```json
{
  "id": "uuid",
  "name": "support-docs",
  "description": "Product support documentation",
  "accessMode": "shared",
  "chunkSize": 512,
  "chunkOverlap": 64,
  "createdAt": "2026-04-23T10:00:00Z",
  "updatedAt": "2026-04-23T10:00:00Z"
}
```

### CollectionDetails

`Collection`に次のフィールドを追加した形式です。

```json
{
  "documentCount": 12,
  "chunkCount": 347
}
```

### RagDocument

```json
{
  "id": "uuid",
  "collectionId": "uuid",
  "filename": "refund-policy.pdf",
  "status": "ready",
  "chunkCount": 28,
  "metadata": {},
  "errorMessage": null,
  "createdAt": "2026-04-23T10:00:00Z",
  "updatedAt": "2026-04-23T10:01:30Z"
}
```

**状態の値：** `pending` → `processing` → `ready`または`failed`

### IngestResult

```json
{
  "documentId": "uuid",
  "status": "pending",
  "message": "Document queued for processing"
}
```

### QueryResult

```json
{
  "chunks": [
    {
      "text": "Refunds are accepted within 30 days...",
      "score": 0.92,
      "documentId": "uuid",
      "metadata": {}
    }
  ]
}
```

### SynthesizedQueryResult

`QueryResult`に次のフィールドを追加した形式です。

```json
{
  "chunks": [...],
  "answer": "Refunds are accepted within 30 days of purchase with a valid receipt.",
  "model": "anthropic/claude-haiku-4-5"
}
```
