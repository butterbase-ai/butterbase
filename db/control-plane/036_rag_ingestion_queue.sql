-- @scope: platform
-- RAG ingestion queue for background document processing
-- Worker polls this table to find pending ingestion jobs across all apps

CREATE TABLE IF NOT EXISTS rag_ingestion_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  collection_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error_message TEXT,
  locked_at TIMESTAMPTZ,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_queue_pending
  ON rag_ingestion_queue (status, run_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_rag_queue_app
  ON rag_ingestion_queue (app_id);
