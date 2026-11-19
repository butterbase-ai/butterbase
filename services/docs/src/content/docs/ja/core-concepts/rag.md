---
title: 組み込みRAG
description: 文書を取り込んで自然言語検索します。分割・埋め込み・ベクトル保存は自動で処理します。
---

組み込みのRAG（検索拡張生成）で文書を取り込み、意味に基づいて検索できます。チャンク分割、text-embedding-3-smallによる埋め込み、pgvectorへの保存を自動処理し、取り込みと検索の2つのAPIで利用します。

<span id="how-it-works"></span>

## 仕組み

1. **取り込み** — ファイルか生のテキストを解析し、重なりのあるチャンクへ分割してベクトル化。
2. **保存** — アプリのDB内のpgvectorへ保存。HNSWインデックスでコサイン類似度検索を高速化。
3. **検索** — 自然言語の質問をベクトル化し、近いチャンクを類似度順で返す。AI回答の生成も指定可能。

取り込みは非同期で、文書IDをすぐに返します。状態APIでreadyになるまで確認してください。

<span id="collections"></span>

## コレクション

関連文書をまとめる名前空間です（例：support-docs、product-manual）。全文書とチャンクはコレクションに所属し、アプリごとに分かれます。

**名前の規則：** 小文字英数字、ハイフン、アンダースコアだけを使用します（support-docs、product_manualなど）。

<span id="access-modes"></span>

### アクセスモード

| モード | 動作 |
|------|----------|
| `private`（既定） | 各ユーザーは自分の文書だけを検索。RLSを自動作成。 |
| `shared` | 全認証ユーザーが全コレクション文書を検索可能。 |
| `custom` | 自動ポリシーなし。自分でRLSを定義。 |

<span id="creating-a-collection"></span>

### コレクションを作成

```json
POST /v1/{app_id}/rag/collections
Authorization: Bearer bb_sk_...

{
  "name": "support-docs",
  "accessMode": "shared",
  "description": "Product support documentation"
}
```

レスポンス：

```json
{
  "id": "uuid",
  "name": "support-docs",
  "description": "Product support documentation",
  "accessMode": "shared",
  "chunkSize": 512,
  "chunkOverlap": 64,
  "createdAt": "2026-04-23T10:00:00Z"
}
```

<span id="ingesting-documents"></span>

## 文書の取り込み

<span id="from-raw-text"></span>

### 生のテキスト

```json
POST /v1/{app_id}/rag/collections/support-docs/ingest
Authorization: Bearer bb_sk_...

{
  "text": "Refunds are accepted within 30 days of purchase...",
  "filename": "refund-policy.txt"
}
```

<span id="from-a-stored-file"></span>

### 保存済みファイル

1. `POST /storage/{app_id}/upload`でアップロードし、objectIdを保存。
2. そのIDを取り込みAPIへ指定：

```json
POST /v1/{app_id}/rag/collections/support-docs/ingest
Authorization: Bearer bb_sk_...

{
  "storage_object_id": "uuid-from-upload"
}
```

<span id="supported-file-types"></span>

### 対応ファイル

| 種類 | 拡張子 |
|------|------------|
| プレーンテキスト | `.txt`、`.md` |
| PDF | `.pdf` |
| Word | `.docx` |
| Excel | `.xlsx` |
| PowerPoint | `.pptx` |
| HTML | `.html` |
| CSV | `.csv` |

<span id="async-lifecycle"></span>

### 非同期処理の流れ

```
pending → processing → ready
                    ↘ failed
```

status: pendingですぐに返します。`GET /v1/{app_id}/rag/collections/{name}/documents/{id}`でreadyかfailedになるまで確認します。

<span id="querying"></span>

## 検索

```json
POST /v1/{app_id}/rag/collections/support-docs/query
Authorization: Bearer Bearer bb_sk_...

{
  "query": "What is the refund policy?",
  "topK": 5,
  "threshold": 0.7
}
```

レスポンス：

```json
{
  "chunks": [
    {
      "text": "Refunds are accepted within 30 days of purchase...",
      "score": 0.92,
      "documentId": "uuid",
      "metadata": {}
    }
  ]
}
```

<span id="query-parameters"></span>

### 検索パラメーター

| パラメーター | 型 | 既定値 | 説明 |
|-----------|------|---------|-------------|
| `query` | string | 必須 | 自然言語の質問 |
| `topK` | number | 5 | 返すチャンク数 |
| `threshold` | number | — | 最低類似度（0〜1）。未満のチャンクは除外 |
| `synthesize` | boolean | false | 取得チャンクからAI回答を生成 |
| `model` | string | auto | 回答モデル（例：anthropic/claude-haiku-4-5） |
| `filter` | object | — | 結果を絞るメタデータ |

<span id="synthesized-answers"></span>

### 回答の生成

synthesize: trueでチャンクと一緒にAI回答を取得します。

```json
{
  "query": "What is the refund policy?",
  "synthesize": true
}
```

answerフィールドを返します。

```json
{
  "chunks": [...],
  "answer": "Refunds are accepted within 30 days of purchase with a valid receipt.",
  "model": "anthropic/claude-haiku-4-5"
}
```

<span id="access-control"></span>

## アクセス制御

通常のテーブルと同じRLSモデルを使います。

- **private** — ユーザー固有の文書・チャンクだけを許可。取り込み時のuser_idをリクエストJWTと照合。
- **shared** — 全認証ユーザーの読み取りを許可。
- **custom** — 自動作成なし。スキーマツールからCREATE POLICYで定義。

<span id="sdk-usage"></span>

## SDKでの利用

```typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
});

// Create a shared collection
await butterbase.rag.createCollection({
  name: 'support-docs',
  accessMode: 'shared',
});

// Ingest raw text
const { data: doc } = await butterbase.rag.ingest('support-docs', {
  text: 'Refunds are accepted within 30 days of purchase...',
  filename: 'refund-policy.txt',
});

// Poll until ready
let status = doc.status;
while (status === 'pending' || status === 'processing') {
  await new Promise(r => setTimeout(r, 1000));
  const { data } = await butterbase.rag.getDocument('support-docs', doc.documentId);
  status = data.status;
}

// Query with synthesis
const { data: result } = await butterbase.rag.query('support-docs', {
  query: 'What is the return policy?',
  synthesize: true,
});
console.log(result.answer);
```

<span id="ai-credits"></span>

## AIクレジット

- 取り込み・検索の埋め込み費用をAIクレジットから消費。
- synthesize: trueではLLM費用も消費。
- アップロード文書のファイルをストレージ使用量に算入。
- RAG専用の追加料金はなし。
