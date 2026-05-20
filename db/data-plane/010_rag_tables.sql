-- @scope: data
-- RAG (Retrieval-Augmented Generation) tables
-- Provides managed document ingestion, chunking, embedding, and semantic search

-- Collections: namespace for related documents with access control
CREATE TABLE IF NOT EXISTS _rag_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  access_mode TEXT NOT NULL DEFAULT 'private'
    CHECK (access_mode IN ('private', 'shared', 'custom')),
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dimensions INTEGER NOT NULL DEFAULT 1536,
  chunk_size INTEGER NOT NULL DEFAULT 512,
  chunk_overlap INTEGER NOT NULL DEFAULT 50,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Documents: tracks ingested files/text and processing status
CREATE TABLE IF NOT EXISTS _rag_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES _rag_collections(id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('file', 'text', 'url')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  error_message TEXT,
  chunk_count INTEGER,
  s3_key TEXT,
  user_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chunks: embeddings and text segments for similarity search
CREATE TABLE IF NOT EXISTS _rag_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES _rag_documents(id) ON DELETE CASCADE,
  collection_id UUID NOT NULL REFERENCES _rag_collections(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  chunk_index INTEGER NOT NULL,
  token_count INTEGER,
  user_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_rag_chunks_embedding
  ON _rag_chunks USING hnsw (embedding vector_cosine_ops);

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_rag_chunks_collection ON _rag_chunks (collection_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON _rag_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_collection ON _rag_documents (collection_id);
CREATE INDEX IF NOT EXISTS idx_rag_documents_status ON _rag_documents (status);

-- Enable RLS on all RAG tables
ALTER TABLE _rag_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE _rag_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE _rag_chunks ENABLE ROW LEVEL SECURITY;

-- Service role bypass policies (butterbase_service has full access)
CREATE POLICY rag_collections_service ON _rag_collections
  FOR ALL TO butterbase_service USING (true) WITH CHECK (true);
CREATE POLICY rag_documents_service ON _rag_documents
  FOR ALL TO butterbase_service USING (true) WITH CHECK (true);
CREATE POLICY rag_chunks_service ON _rag_chunks
  FOR ALL TO butterbase_service USING (true) WITH CHECK (true);
