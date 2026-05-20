---
title: RAG API
description: API reference for Butterbase native RAG — collections, ingestion, and semantic query endpoints.
sidebar:
  order: 9
---

All RAG endpoints are under `/v1/{app_id}/rag/`. Authentication: `Authorization: Bearer {service_key_or_jwt}`.

See [RAG (Native)](/core-concepts/rag) for conceptual overview and SDK examples.

## Collections

### Create collection

```
POST /v1/{app_id}/rag/collections
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Lowercase alphanumeric, hyphens, underscores |
| `description` | string | No | Human-readable description |
| `accessMode` | `private` \| `shared` \| `custom` | No | Default: `private` |
| `chunkSize` | number | No | Characters per chunk. Default: 512 |
| `chunkOverlap` | number | No | Overlap between chunks. Default: 64 |

**Response:** `Collection` object (201).

---

### List collections

```
GET /v1/{app_id}/rag/collections
```

**Response:** Array of `Collection` objects.

---

### Get collection

```
GET /v1/{app_id}/rag/collections/{name}
```

Returns collection details including document and chunk counts.

**Response:** `CollectionDetails` object.

---

### Delete collection

```
DELETE /v1/{app_id}/rag/collections/{name}
```

Permanently deletes the collection and all its documents, chunks, and embeddings. Irreversible.

**Response:** `204 No Content`.

---

## Documents

### Ingest document

```
POST /v1/{app_id}/rag/collections/{name}/ingest
```

Enqueues a document for async processing. Returns immediately with `status: "pending"`.

**Request body (text):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes* | Raw text content to ingest |
| `filename` | string | No | Display name for the document |
| `metadata` | object | No | Arbitrary key-value metadata stored with each chunk |

**Request body (file from storage):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `storage_object_id` | string | Yes* | Object ID returned by the storage upload endpoint |
| `filename` | string | No | Override display name |
| `metadata` | object | No | Arbitrary key-value metadata |

*Either `text` or `storage_object_id` is required.

**Response:** `IngestResult` object (202).

```json
{
  "documentId": "uuid",
  "status": "pending",
  "message": "Document queued for processing"
}
```

---

### List documents

```
GET /v1/{app_id}/rag/collections/{name}/documents
```

**Response:** Array of `RagDocument` objects.

---

### Get document

```
GET /v1/{app_id}/rag/collections/{name}/documents/{document_id}
```

Returns document status and metadata. Use this to poll until `status` is `ready` or `failed`.

**Response:** `RagDocument` object.

---

### Delete document

```
DELETE /v1/{app_id}/rag/collections/{name}/documents/{document_id}
```

Deletes the document and all its vector chunks. Irreversible.

**Response:** `204 No Content`.

---

## Query

### Semantic query

```
POST /v1/{app_id}/rag/collections/{name}/query
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `query` | string | Yes | Natural language question |
| `topK` | number | No | Number of chunks to return. Default: 5 |
| `threshold` | number | No | Minimum cosine similarity (0–1). Chunks below excluded. |
| `synthesize` | boolean | No | Generate an AI answer from retrieved chunks. Default: false |
| `model` | string | No | Model for synthesis (e.g. `anthropic/claude-haiku-4-5`). Auto-selected if omitted. |
| `filter` | object | No | Metadata filter (key-value pairs). Only chunks with matching metadata are returned. |

**Response:** `QueryResult` (when `synthesize: false`) or `SynthesizedQueryResult` (when `synthesize: true`).

---

## Response schemas

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

Extends `Collection` with:

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

**Status values:** `pending` → `processing` → `ready` | `failed`

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

Extends `QueryResult` with:

```json
{
  "chunks": [...],
  "answer": "Refunds are accepted within 30 days of purchase with a valid receipt.",
  "model": "anthropic/claude-haiku-4-5"
}
```
