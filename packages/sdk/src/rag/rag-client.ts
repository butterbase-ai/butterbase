import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  Collection,
  CollectionDetails,
  RagDocument,
  IngestResult,
  QueryResult,
  QueryChunk,
  CreateCollectionOptions,
  IngestOptions,
  QueryOptions,
} from './types.js';

export class RagClient {
  constructor(private client: ButterbaseClient) {}

  /**
   * Create a new RAG collection
   */
  async createCollection(
    options: CreateCollectionOptions
  ): Promise<ButterbaseResponse<Collection>> {
    try {
      const body: Record<string, unknown> = { name: options.name };
      if (options.description !== undefined) body.description = options.description;
      if (options.accessMode !== undefined) body.accessMode = options.accessMode;
      if (options.chunkSize !== undefined) body.chunkSize = options.chunkSize;
      if (options.chunkOverlap !== undefined) body.chunkOverlap = options.chunkOverlap;

      const data = await this.client.request<Collection>(
        'POST',
        `/v1/${this.client.appId}/rag/collections`,
        body
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * List all RAG collections
   */
  async listCollections(): Promise<ButterbaseResponse<Collection[]>> {
    try {
      const data = await this.client.request<Collection[]>(
        'GET',
        `/v1/${this.client.appId}/rag/collections`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Get details for a specific collection, including document counts
   */
  async getCollection(
    name: string
  ): Promise<ButterbaseResponse<CollectionDetails>> {
    try {
      const data = await this.client.request<CollectionDetails>(
        'GET',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(name)}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Delete a collection and all its documents
   */
  async deleteCollection(name: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'DELETE',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(name)}`
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Ingest a file or text into a collection.
   *
   * If `options.file` is provided, the file is uploaded to storage first,
   * then the storage object ID is passed to the ingest endpoint.
   *
   * If `options.text` is provided, the raw text is sent directly.
   */
  async ingest(
    collection: string,
    options: IngestOptions
  ): Promise<ButterbaseResponse<IngestResult>> {
    try {
      const body: Record<string, unknown> = {};

      if (options.file) {
        // Step 1: Upload file to storage to get an object ID
        const filename = options.filename || (options.file as File).name || 'file';
        const uploadData = await this.client.request<{
          uploadUrl: string;
          objectKey: string;
          objectId: string;
          expiresIn: number;
        }>(
          'POST',
          `/storage/${this.client.appId}/upload`,
          {
            filename,
            contentType: options.file.type || 'application/octet-stream',
            sizeBytes: options.file.size,
            public: false,
          }
        );

        // Step 2: Upload the file to the presigned URL
        const uploadResponse = await fetch(uploadData.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': options.file.type || 'application/octet-stream' },
          body: options.file,
        });

        if (!uploadResponse.ok) {
          throw new Error('Failed to upload file to storage');
        }

        // Step 3: Ingest using the storage object ID
        body.storage_object_id = uploadData.objectId;
        if (options.filename) body.filename = options.filename;
      } else if (options.text) {
        body.text = options.text;
        if (options.filename) body.filename = options.filename;
      } else {
        throw new Error('Either file or text must be provided');
      }

      if (options.metadata) body.metadata = options.metadata;

      const data = await this.client.request<IngestResult>(
        'POST',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(collection)}/ingest`,
        body
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Get a specific document by ID
   */
  async getDocument(
    collection: string,
    documentId: string
  ): Promise<ButterbaseResponse<RagDocument>> {
    try {
      const data = await this.client.request<RagDocument>(
        'GET',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(documentId)}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * List all documents in a collection
   */
  async listDocuments(
    collection: string
  ): Promise<ButterbaseResponse<RagDocument[]>> {
    try {
      const data = await this.client.request<RagDocument[]>(
        'GET',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(collection)}/documents`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Delete a document and its chunks from a collection
   */
  async deleteDocument(
    collection: string,
    documentId: string
  ): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'DELETE',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(documentId)}`
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Query a collection for relevant chunks.
   *
   * When `options.synthesize` is true, the response includes an AI-generated
   * answer in addition to the matching chunks.
   */
  async query(
    collection: string,
    options: QueryOptions
  ): Promise<ButterbaseResponse<QueryResult>> {
    try {
      const body: Record<string, unknown> = { query: options.query };
      if (options.topK !== undefined) body.topK = options.topK;
      if (options.threshold !== undefined) body.threshold = options.threshold;
      if (options.synthesize !== undefined) body.synthesize = options.synthesize;
      if (options.model !== undefined) body.model = options.model;
      if (options.filter !== undefined) body.filter = options.filter;

      const raw = await this.client.request<any>(
        'POST',
        `/v1/${this.client.appId}/rag/collections/${encodeURIComponent(collection)}/query`,
        body,
      );

      const rawChunks: any[] = raw?.results ?? raw?.hits ?? raw?.documents ?? raw?.chunks ?? [];
      const chunks: QueryChunk[] = rawChunks.map((c) => ({
        id: c.id,
        content: c.content ?? c.text ?? '',
        score: c.score,
        document: c.document,
        metadata: c.metadata,
      }));

      return {
        data: {
          chunks,
          answer: raw?.answer ?? raw?.synthesis,
          model: raw?.model,
          usage: raw?.usage,
        },
        error: null,
      };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
