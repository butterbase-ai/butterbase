import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { EdgeSsrDeployment, EdgeSsrFromSourceStartParams } from './types.js';
import { consumeSse, type SseEvent } from '../lib/sse.js';

export interface CreateEdgeSsrDeploymentParams {
  framework?: 'nextjs-edge' | 'remix-edge' | 'other-edge';
}

export interface EdgeSsrCreateDeploymentResult {
  id: string;
  upload_url: string;
  framework: string | null;
}

export interface EdgeSsrFromSourceCreateResult {
  deployment_id: string;
  build_id: string;
  upload_url: string;
  max_source_bytes: number;
}

export interface EdgeSsrFromSourceStartResult {
  build_id: string;
  status: string;
  logs_url: string;
  status_url: string;
}

export class AdminEdgeSsrClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async createDeployment(params?: CreateEdgeSsrDeploymentParams): Promise<ButterbaseResponse<EdgeSsrCreateDeploymentResult>> {
    try {
      const data = await this.client.request<EdgeSsrCreateDeploymentResult>(
        'POST', `/v1/${this.client.appId}/edge-ssr/deployments`, params ?? {}
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async startDeployment(id: string): Promise<ButterbaseResponse<EdgeSsrDeployment>> {
    try {
      const data = await this.client.request<EdgeSsrDeployment>(
        'POST', `/v1/${this.client.appId}/edge-ssr/deployments/${id}/start`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async syncDeployment(id: string): Promise<ButterbaseResponse<EdgeSsrDeployment>> {
    try {
      const data = await this.client.request<EdgeSsrDeployment>(
        'POST', `/v1/${this.client.appId}/edge-ssr/deployments/${id}/sync`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async cancelDeployment(id: string): Promise<ButterbaseResponse<EdgeSsrDeployment>> {
    try {
      const data = await this.client.request<EdgeSsrDeployment>(
        'POST', `/v1/${this.client.appId}/edge-ssr/deployments/${id}/cancel`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listDeployments(): Promise<ButterbaseResponse<{ deployments: EdgeSsrDeployment[] }>> {
    try {
      const data = await this.client.request<{ deployments: EdgeSsrDeployment[] }>(
        'GET', `/v1/${this.client.appId}/edge-ssr/deployments`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getDeployment(id: string): Promise<ButterbaseResponse<EdgeSsrDeployment>> {
    try {
      const data = await this.client.request<EdgeSsrDeployment>(
        'GET', `/v1/${this.client.appId}/edge-ssr/deployments/${id}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async deleteDeployment(id: string): Promise<ButterbaseResponse<{ deleted: boolean }>> {
    try {
      const data = await this.client.request<{ deleted: boolean }>(
        'DELETE', `/v1/${this.client.appId}/edge-ssr/deployments/${id}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Create a from-source deployment. Returns a presigned R2 upload URL for the
   * source zip. Upload the zip there, then call `startFromSource`.
   */
  async createFromSource(params?: CreateEdgeSsrDeploymentParams): Promise<ButterbaseResponse<EdgeSsrFromSourceCreateResult>> {
    try {
      const data = await this.client.request<EdgeSsrFromSourceCreateResult>(
        'POST', `/v1/${this.client.appId}/edge-ssr/deployments/from-source`, params ?? {}
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Start the build for a from-source deployment. The source zip must have
   * been uploaded to the presigned URL returned by `createFromSource` first.
   *
   * For live build logs, use `streamBuildLogs(deploymentId, onEvent)`.
   */
  async startFromSource(deploymentId: string, buildOpts: EdgeSsrFromSourceStartParams): Promise<ButterbaseResponse<EdgeSsrFromSourceStartResult>> {
    try {
      const data = await this.client.request<EdgeSsrFromSourceStartResult>(
        'POST', `/v1/${this.client.appId}/edge-ssr/deployments/from-source/${deploymentId}/start`, buildOpts
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Stream live build logs from a from-source deployment via SSE. Resolves
   * when the stream closes (typically after a `done` event).
   */
  async streamBuildLogs(deploymentId: string, onEvent: (e: SseEvent) => void): Promise<void> {
    const stream = await this.client.requestStream(
      'GET',
      `/v1/${this.client.appId}/edge-ssr/deployments/from-source/${deploymentId}/logs`,
    );
    await consumeSse(stream, onEvent);
  }
}
