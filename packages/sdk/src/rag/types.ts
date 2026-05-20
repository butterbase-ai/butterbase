export interface Collection {
  id: string;
  name: string;
  description: string | null;
  access_mode: 'private' | 'shared' | 'custom';
  embedding_model: string;
  embedding_dimensions: number;
  chunk_size: number;
  chunk_overlap: number;
  created_by: string | null;
  created_at: string;
}

export interface CollectionDetails extends Collection {
  document_counts: {
    total: number;
    pending: number;
    processing: number;
    ready: number;
    failed: number;
  };
}

export interface RagDocument {
  id: string;
  filename: string | null;
  content_type: string | null;
  source_type: 'file' | 'text' | 'url';
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error_message: string | null;
  chunk_count: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface IngestResult {
  documentId: string;
  status: 'pending';
  collection: string;
}

export interface QueryChunk {
  id: string;
  content: string;
  score?: number;
  document?: { id: string; filename?: string };
  metadata?: Record<string, unknown>;
}

export interface QueryResult {
  chunks: QueryChunk[];
  /** Present when synthesize=true. */
  answer?: string;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface CreateCollectionOptions {
  name: string;
  description?: string;
  accessMode?: 'private' | 'shared' | 'custom';
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface IngestOptions {
  file?: Blob | File;
  text?: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  query: string;
  topK?: number;
  threshold?: number;
  synthesize?: boolean;
  model?: string;
  filter?: Record<string, unknown>;
}
