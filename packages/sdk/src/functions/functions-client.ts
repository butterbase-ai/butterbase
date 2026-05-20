import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse, InvokeFunctionOptions } from '../types/index.js';

export class FunctionsClient {
  constructor(private client: ButterbaseClient) {}

  /**
   * Invoke a serverless function
   */
  async invoke<T = any>(
    functionName: string,
    options?: InvokeFunctionOptions
  ): Promise<ButterbaseResponse<T>> {
    try {
      const method = options?.method || 'POST';
      const path = `/v1/${this.client.appId}/fn/${functionName}`;

      const data = await this.client.request<T>(
        method,
        path,
        options?.body,
        options?.headers
      );

      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Invoke a serverless function that returns binary data (blob)
   * Use this for functions that return files, images, or other binary content
   */
  async invokeBlob(
    functionName: string,
    options?: InvokeFunctionOptions
  ): Promise<ButterbaseResponse<Blob>> {
    try {
      const method = options?.method || 'POST';
      const path = `/v1/${this.client.appId}/fn/${functionName}`;

      const blob = await this.client.requestBlob(
        method,
        path,
        options?.body,
        options?.headers
      );

      return { data: blob, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Delete a serverless function
   */
  async delete(functionName: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request(
        'DELETE',
        `/v1/${this.client.appId}/functions/${functionName}`
      );

      return { data: undefined, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
