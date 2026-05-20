import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, getBaseUrl, getHeaders } from '../api-client.js';

export function registerManageRagContent(server: McpServer) {
  server.tool(
    'manage_rag_content',
    `Manage RAG (Retrieval-Augmented Generation) collections and documents. Collections are named
containers for documents that are chunked, embedded, and indexed for semantic search.

Actions:
  Collection actions:
  - "create_collection": Create a new collection
  - "list_collections":  List all collections in an app
  - "get_collection":    Get details for a specific collection (includes document counts by status)
  - "delete_collection": Permanently delete a collection and all its documents/embeddings

  Document actions:
  - "ingest_document":     Add a document (raw text or uploaded file) to be chunked, embedded, and indexed
  - "list_documents":      List all documents in a collection with their status
  - "get_document_status": Check the processing status of a specific document
  - "delete_document":     Permanently delete a document and its chunks/embeddings

Parameters by action:
  create_collection:   { app_id, action: "create_collection", name, description?, access_mode?, chunk_size?, chunk_overlap? }
  list_collections:    { app_id, action: "list_collections" }
  get_collection:      { app_id, action: "get_collection", name }
  delete_collection:   { app_id, action: "delete_collection", name }
  ingest_document:     { app_id, collection, action: "ingest_document", text?, storage_object_id?, filename?, metadata? }
  list_documents:      { app_id, collection, action: "list_documents" }
  get_document_status: { app_id, collection, action: "get_document_status", document_id }
  delete_document:     { app_id, collection, action: "delete_document", document_id }

access_mode options (create_collection):
  - "private" (default): Only the app owner can query
  - "shared": All authenticated users can query
  - "custom": Use RLS policies for fine-grained access

Ingestion modes for ingest_document (provide one):
  1. Raw text: provide "text" directly
  2. File-based: upload via manage_storage (action: "upload_url") first, then provide "storage_object_id"

Supported file types: PDF, TXT, Markdown, CSV, HTML, DOCX, XLSX, PPTX.

Document statuses: "pending" → "processing" → "ready" (or "failed")

Workflow: create_collection → ingest_document → poll get_document_status until "ready" → query with rag_query.

Warning: "delete_collection" permanently removes the collection, all documents, and embeddings. Cannot be undone.
Warning: "delete_document" permanently removes the document and its embeddings. To replace, delete then re-ingest.

Common errors:
  - RESOURCE_NOT_FOUND: App, collection, or document doesn't exist
  - VALIDATION_DUPLICATE_NAME: Collection name already exists (create_collection)
  - VALIDATION_ERROR: Neither text nor storage_object_id provided (ingest_document)`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      action: z.enum([
        'create_collection',
        'list_collections',
        'get_collection',
        'delete_collection',
        'ingest_document',
        'list_documents',
        'get_document_status',
        'delete_document',
      ]).describe('The action to perform'),
      // Collection params
      name: z.string().optional().describe('Collection name (required for create_collection/get_collection/delete_collection). Lowercase alphanumeric, hyphens, underscores only.'),
      description: z.string().optional().describe('Human-readable description (create_collection only)'),
      access_mode: z.enum(['private', 'shared', 'custom']).optional().describe('Access control mode (create_collection only, default: private)'),
      chunk_size: z.number().optional().describe('Max tokens per chunk (create_collection only, default: 512)'),
      chunk_overlap: z.number().optional().describe('Overlap tokens between chunks (create_collection only, default: 50)'),
      // Document params
      collection: z.string().optional().describe('The collection name (required for document actions)'),
      document_id: z.string().optional().describe('Document ID (required for get_document_status/delete_document)'),
      text: z.string().optional().describe('Raw text content to ingest (ingest_document only)'),
      storage_object_id: z.string().optional().describe('UUID of an uploaded storage object from manage_storage action: "upload_url" (ingest_document only)'),
      filename: z.string().optional().describe('Filename hint for display and format detection (ingest_document only)'),
      metadata: z.record(z.any()).optional().describe('Key-value metadata to attach (ingest_document only, e.g. { source: "wiki" })'),
    },
    {
      title: 'Manage RAG Content',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const {
        app_id, action,
        name, description, access_mode, chunk_size, chunk_overlap,
        collection, document_id, text, storage_object_id, filename, metadata,
      } = args;

      switch (action) {
        case 'create_collection': {
          if (!name) {
            return { content: [{ type: 'text' as const, text: 'Error: "name" is required for the "create_collection" action.' }], isError: true };
          }
          const url = `${getBaseUrl()}/v1/${app_id}/rag/collections`;
          const res = await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
              name,
              description,
              accessMode: access_mode,
              chunkSize: chunk_size,
              chunkOverlap: chunk_overlap,
            }),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'list_collections': {
          const result = await apiGet(`/v1/${app_id}/rag/collections`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_collection': {
          if (!name) {
            return { content: [{ type: 'text' as const, text: 'Error: "name" is required for the "get_collection" action.' }], isError: true };
          }
          const result = await apiGet(`/v1/${app_id}/rag/collections/${name}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'delete_collection': {
          if (!name) {
            return { content: [{ type: 'text' as const, text: 'Error: "name" is required for the "delete_collection" action.' }], isError: true };
          }
          const url = `${getBaseUrl()}/v1/${app_id}/rag/collections/${name}`;
          const headers = { ...(getHeaders() as Record<string, string>) };
          delete headers['Content-Type'];
          const res = await fetch(url, { method: 'DELETE', headers });
          if (res.status === 204) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Collection deleted', name }, null, 2) }] };
          }
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'ingest_document': {
          if (!collection) {
            return { content: [{ type: 'text' as const, text: 'Error: "collection" is required for the "ingest_document" action.' }], isError: true };
          }
          if (!text && !storage_object_id) {
            return { content: [{ type: 'text' as const, text: 'Error: Provide either "text" or "storage_object_id" for the "ingest_document" action.' }], isError: true };
          }
          const url = `${getBaseUrl()}/v1/${app_id}/rag/collections/${collection}/ingest`;
          const res = await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ text, storage_object_id, filename, metadata }),
          });
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }

        case 'list_documents': {
          if (!collection) {
            return { content: [{ type: 'text' as const, text: 'Error: "collection" is required for the "list_documents" action.' }], isError: true };
          }
          const result = await apiGet(`/v1/${app_id}/rag/collections/${collection}/documents`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_document_status': {
          if (!collection) {
            return { content: [{ type: 'text' as const, text: 'Error: "collection" is required for the "get_document_status" action.' }], isError: true };
          }
          if (!document_id) {
            return { content: [{ type: 'text' as const, text: 'Error: "document_id" is required for the "get_document_status" action.' }], isError: true };
          }
          const result = await apiGet(`/v1/${app_id}/rag/collections/${collection}/documents/${document_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }

        case 'delete_document': {
          if (!collection) {
            return { content: [{ type: 'text' as const, text: 'Error: "collection" is required for the "delete_document" action.' }], isError: true };
          }
          if (!document_id) {
            return { content: [{ type: 'text' as const, text: 'Error: "document_id" is required for the "delete_document" action.' }], isError: true };
          }
          const url = `${getBaseUrl()}/v1/${app_id}/rag/collections/${collection}/documents/${document_id}`;
          const headers = { ...(getHeaders() as Record<string, string>) };
          delete headers['Content-Type'];
          const res = await fetch(url, { method: 'DELETE', headers });
          if (res.status === 204) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Document deleted', document_id }, null, 2) }] };
          }
          const data = await res.json();
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
            ...(res.ok ? {} : { isError: true }),
          };
        }
      }
    }
  );
}
