---
title: RAG (Native)
description: Ingest documents and query them with natural language. The platform handles chunking, embedding, and vector storage — no ML infrastructure required.
---

Butterbase includes a native RAG (Retrieval-Augmented Generation) primitive that lets your app ingest documents and search them semantically. The platform handles chunking, embedding with `text-embedding-3-small`, and vector storage via pgvector — two API calls: ingest and query.

## How it works

1. **Ingest** — Upload a file or pass raw text. The platform parses the content, splits it into overlapping chunks, and generates vector embeddings.
2. **Store** — Chunks and embeddings are stored in pgvector (HNSW index for fast cosine similarity search) inside your app's database.
3. **Query** — Send a natural language question. The platform embeds it, finds the most similar chunks, and returns them ranked by similarity. Optionally synthesizes an AI answer.

Processing is asynchronous. Ingestion returns immediately with a document ID; use the status endpoint to poll until `ready`.

## Collections

A **collection** is a namespace for related documents (e.g. `support-docs`, `product-manual`). All ingested documents and their chunks belong to a collection. Collections are scoped to your app.

**Name rules:** lowercase alphanumeric, hyphens, and underscores only (e.g. `support-docs`, `product_manual`).

### Access modes

| Mode | Behavior |
|------|----------|
| `private` (default) | Each user can only query their own documents. RLS policies are auto-created. |
| `shared` | All authenticated users can query all documents in the collection. |
| `custom` | No auto-policies are created — define your own RLS rules. |

### Creating a collection

```json
POST /v1/{app_id}/rag/collections
Authorization: Bearer bb_sk_...

{
  "name": "support-docs",
  "accessMode": "shared",
  "description": "Product support documentation"
}
```

Response:

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

## Ingesting documents

### From raw text

```json
POST /v1/{app_id}/rag/collections/support-docs/ingest
Authorization: Bearer bb_sk_...

{
  "text": "Refunds are accepted within 30 days of purchase...",
  "filename": "refund-policy.txt"
}
```

### From a stored file

1. Upload the file using `POST /storage/{app_id}/upload` and save the returned `objectId`.
2. Pass that ID to the ingest endpoint:

```json
POST /v1/{app_id}/rag/collections/support-docs/ingest
Authorization: Bearer bb_sk_...

{
  "storage_object_id": "uuid-from-upload"
}
```

### Supported file types

| Type | Extensions |
|------|------------|
| Plain text | `.txt`, `.md` |
| PDF | `.pdf` |
| Word | `.docx` |
| Excel | `.xlsx` |
| PowerPoint | `.pptx` |
| HTML | `.html` |
| CSV | `.csv` |

### Async lifecycle

```
pending → processing → ready
                    ↘ failed
```

The ingest response returns immediately with `status: "pending"`. Poll with `GET /v1/{app_id}/rag/collections/{name}/documents/{id}` until status is `ready` or `failed`.

## Querying

```json
POST /v1/{app_id}/rag/collections/support-docs/query
Authorization: Bearer Bearer bb_sk_...

{
  "query": "What is the refund policy?",
  "topK": 5,
  "threshold": 0.7
}
```

Response:

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

### Query parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Natural language question |
| `topK` | number | 5 | Number of chunks to return |
| `threshold` | number | — | Minimum similarity score (0–1); chunks below excluded |
| `synthesize` | boolean | false | Generate an AI answer from the retrieved chunks |
| `model` | string | auto | Model to use for synthesis (e.g. `anthropic/claude-haiku-4-5`) |
| `filter` | object | — | Metadata filter to narrow results |

### Synthesized answers

Set `synthesize: true` to get an AI-generated answer in addition to the raw chunks:

```json
{
  "query": "What is the refund policy?",
  "synthesize": true
}
```

Response includes an `answer` field:

```json
{
  "chunks": [...],
  "answer": "Refunds are accepted within 30 days of purchase with a valid receipt.",
  "model": "anthropic/claude-haiku-4-5"
}
```

## Access control

RAG collections respect the same RLS model as regular tables:

- **`private`** — Auto-created policies restrict each user to their own documents and chunks. The `user_id` stored at ingest time is matched against the request JWT.
- **`shared`** — Auto-created policies allow all authenticated users to read all documents and chunks.
- **`custom`** — No policies are created. You define your own using `CREATE POLICY` via the schema tools.

## SDK usage

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

## AI credits

- Embedding costs during ingestion and querying count against your plan's AI credits allowance.
- Synthesis (when `synthesize: true`) uses an LLM and also counts against AI credits.
- File storage for uploaded documents counts against your storage quota.
- No additional RAG-specific charges.
