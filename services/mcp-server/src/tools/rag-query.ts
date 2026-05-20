import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBaseUrl, getHeaders } from '../api-client.js';

export function registerRagQuery(server: McpServer) {
  server.tool(
    'rag_query',
    `Query a RAG collection using natural language to retrieve relevant document chunks.

Performs semantic search over the collection's indexed documents and returns the most
relevant chunks ranked by similarity. Optionally synthesizes an AI-generated answer
using the retrieved context.

Parameters:
  - query: Natural language question or search phrase
  - top_k: Number of chunks to retrieve (default 5, max 20)
  - threshold: Minimum similarity score 0-1 (only return chunks above this score)
  - synthesize: If true, uses an LLM to generate a natural language answer from the
    retrieved chunks (default false — returns raw chunks only)
  - model: LLM model to use for synthesis (only relevant when synthesize is true,
    default: anthropic/claude-haiku-4.5)
  - filter: Metadata filter to narrow results (e.g. { category: "faq" })

Example — raw retrieval:
  Input: {
    app_id: "app_abc123",
    collection: "knowledge-base",
    query: "How do I reset my password?",
    top_k: 3
  }
  Output: {
    chunks: [
      {
        text: "To reset your password, go to Settings > Security > Reset Password...",
        score: 0.92,
        document_id: "doc_abc",
        metadata: { category: "faq", source: "help-center" }
      },
      ...
    ]
  }

Example — with synthesis:
  Input: {
    app_id: "app_abc123",
    collection: "knowledge-base",
    query: "How do I reset my password?",
    top_k: 5,
    synthesize: true
  }
  Output: {
    answer: "To reset your password, navigate to Settings > Security and click...",
    chunks: [ ... ],
    model: "gpt-4o-mini"
  }

Example — with metadata filter:
  Input: {
    app_id: "app_abc123",
    collection: "knowledge-base",
    query: "pricing plans",
    filter: { category: "billing", version: "2.0" }
  }

Use this to:
  - Search documentation or knowledge bases using natural language
  - Build AI-powered Q&A features for end users
  - Find relevant context for AI assistants
  - Power search bars with semantic understanding

Common errors:
  - RESOURCE_NOT_FOUND: App or collection doesn't exist
  - COLLECTION_EMPTY: No documents have been ingested yet

Idempotency: Safe to call anytime (read-only operation).`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      collection: z.string().describe('The collection name to query'),
      query: z.string().describe('Natural language query or search phrase'),
      top_k: z.number().optional().default(5).describe('Number of top matching chunks to return (default 5, max 20)'),
      threshold: z.number().min(0).max(1).optional().describe('Minimum similarity score (0-1). Only chunks scoring above this threshold are returned.'),
      synthesize: z.boolean().optional().default(false).describe('If true, generate a natural language answer from retrieved chunks using an LLM'),
      model: z.string().optional().describe('LLM model for synthesis (only used when synthesize is true)'),
      filter: z.record(z.any()).optional().describe('Metadata filter to narrow results (e.g. { category: "faq" })'),
    },
    {
      title: 'Query RAG Collection',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, collection, query, top_k, threshold, synthesize, model, filter } = args;

      const url = `${getBaseUrl()}/v1/${app_id}/rag/collections/${collection}/query`;

      const res = await fetch(url, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          query,
          topK: top_k,
          threshold,
          synthesize,
          model,
          filter,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
