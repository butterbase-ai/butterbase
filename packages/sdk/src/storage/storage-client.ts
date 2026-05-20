import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type {
  ButterbaseResponse,
  StorageObject,
  UploadResponse,
  DownloadUrlResponse,
} from '../types/index.js';

export class StorageClient {
  constructor(private client: ButterbaseClient) {}

  /**
   * Upload a file to storage
   * Uses presigned URL flow for direct S3 upload
   */
  async upload(
    file: File | Blob,
    filename?: string,
    options?: { public?: boolean }
  ): Promise<ButterbaseResponse<UploadResponse>> {
    try {
      // Get presigned upload URL
      const uploadData = await this.client.request<{
        uploadUrl: string;
        objectKey: string;
        objectId: string;
        expiresIn: number;
      }>(
        'POST',
        `/storage/${this.client.appId}/upload`,
        {
          filename: filename || (file as File).name || 'file',
          contentType: file.type,
          sizeBytes: file.size,
          public: options?.public ?? false,
        }
      );

      // Upload to S3 using presigned URL
      const uploadResponse = await fetch(uploadData.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
        },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload file to storage');
      }

      return {
        data: {
          objectId: uploadData.objectId,
          objectKey: uploadData.objectKey,
        },
        error: null,
      };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Get a presigned download URL for a file
   */
  async getDownloadUrl(objectId: string): Promise<ButterbaseResponse<DownloadUrlResponse>> {
    try {
      const response = await this.client.request<{
        downloadUrl: string;
        filename: string;
        expiresIn: number;
      }>('GET', `/storage/${this.client.appId}/download/${objectId}`);

      return {
        data: {
          url: response.downloadUrl,
          filename: response.filename,
        },
        error: null,
      };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Delete a file from storage
   */
  async delete(objectId: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'DELETE',
        `/storage/${this.client.appId}/${objectId}`
      );

      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * List all files in storage
   */
  async list(): Promise<ButterbaseResponse<StorageObject[]>> {
    try {
      const response = await this.client.request<{ objects: StorageObject[] }>(
        'GET',
        `/storage/${this.client.appId}/objects`
      );

      return { data: response.objects, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
