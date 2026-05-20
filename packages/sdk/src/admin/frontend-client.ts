import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  Deployment, CreateDeploymentParams, DeploymentCreateResponse,
  FrontendFromSourceCreateResult, FrontendFromSourceStartParams, FrontendFromSourceStartResult,
} from './types.js';
import { consumeSse, type SseEvent } from '../lib/sse.js';

export class AdminFrontendClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async createDeployment(params: CreateDeploymentParams = {}): Promise<ButterbaseResponse<DeploymentCreateResponse>> {
    try {
      const data = await this.client.request<DeploymentCreateResponse>(
        'POST', `/v1/${this.client.appId}/frontend/deployments`, params
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async startDeployment(deploymentId: string): Promise<ButterbaseResponse<Deployment>> {
    try {
      const data = await this.client.request<Deployment>(
        'POST', `/v1/${this.client.appId}/frontend/deployments/${deploymentId}/start`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async listDeployments(): Promise<ButterbaseResponse<Deployment[]>> {
    try {
      const data = await this.client.request<Deployment[]>(
        'GET', `/v1/${this.client.appId}/frontend/deployments`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getDeployment(deploymentId: string): Promise<ButterbaseResponse<Deployment>> {
    try {
      const data = await this.client.request<Deployment>(
        'GET', `/v1/${this.client.appId}/frontend/deployments/${deploymentId}`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async setEnv(vars: Record<string, string>): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<any>(
        'PUT', `/v1/${this.client.appId}/frontend/env`, vars
      );
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async getEnv(): Promise<ButterbaseResponse<string[]>> {
    try {
      const data = await this.client.request<string[]>(
        'GET', `/v1/${this.client.appId}/frontend/env`
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async createFromSource(): Promise<ButterbaseResponse<FrontendFromSourceCreateResult>> {
    try {
      const data = await this.client.request<FrontendFromSourceCreateResult>(
        'POST', `/v1/${this.client.appId}/frontend/deployments/from-source`, {},
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async startFromSource(
    deploymentId: string,
    params: FrontendFromSourceStartParams,
  ): Promise<ButterbaseResponse<FrontendFromSourceStartResult>> {
    try {
      const data = await this.client.request<FrontendFromSourceStartResult>(
        'POST',
        `/v1/${this.client.appId}/frontend/deployments/from-source/${deploymentId}/start`,
        params,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async streamBuildLogs(deploymentId: string, onEvent: (e: SseEvent) => void): Promise<void> {
    const stream = await this.client.requestStream(
      'GET',
      `/v1/${this.client.appId}/frontend/deployments/from-source/${deploymentId}/logs`,
    );
    await consumeSse(stream, onEvent);
  }
}
