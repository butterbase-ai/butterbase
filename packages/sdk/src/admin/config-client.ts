import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { AppConfig, CorsConfig, JwtConfig, StorageConfig, PausedState, SecureAppParams, SecureAppResult, UpdateAccessModeResult } from './types.js';

export class AdminConfigClient {
  private client: ButterbaseClient;

  constructor(client: ButterbaseClient) {
    this.client = client;
  }

  async get(): Promise<ButterbaseResponse<AppConfig>> {
    try {
      const data = await this.client.request<AppConfig>('GET', `/v1/${this.client.appId}/config`);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async updateCors(config: CorsConfig): Promise<ButterbaseResponse<AppConfig>> {
    try {
      const data = await this.client.request<AppConfig>(
        'PATCH', `/v1/${this.client.appId}/config/cors`, config
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async updateJwt(config: JwtConfig): Promise<ButterbaseResponse<AppConfig>> {
    try {
      const data = await this.client.request<AppConfig>(
        'PATCH', `/v1/${this.client.appId}/config/jwt`, config
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async updateStorage(config: StorageConfig): Promise<ButterbaseResponse<AppConfig>> {
    try {
      const data = await this.client.request<AppConfig>(
        'PATCH', `/v1/${this.client.appId}/config/storage`, config
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Pause the app — kill-switch for incident response.
   *
   * While paused, all data-plane traffic (CRUD, storage, realtime, function
   * invocations, cron) returns 503 with code APP_PAUSED. Control-plane
   * endpoints (this client, list, schema) keep working so the operator can
   * inspect state and resume.
   */
  async pause(reason?: string): Promise<ButterbaseResponse<PausedState>> {
    try {
      const data = await this.client.request<PausedState>(
        'PATCH', `/v1/${this.client.appId}/config/pause`, { paused: true, reason }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /** Resume a paused app. Restores all data-plane traffic. */
  async resume(): Promise<ButterbaseResponse<PausedState>> {
    try {
      const data = await this.client.request<PausedState>(
        'PATCH', `/v1/${this.client.appId}/config/pause`, { paused: false }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Set the app's access mode.
   * - `'public'` — unauthenticated requests are allowed on data-plane endpoints.
   * - `'authenticated'` — a valid user JWT or service key is required.
   */
  async updateAccessMode(mode: 'public' | 'authenticated'): Promise<ButterbaseResponse<UpdateAccessModeResult>> {
    try {
      const data = await this.client.request<UpdateAccessModeResult>(
        'PATCH', `/v1/${this.client.appId}/config/access-mode`, { access_mode: mode }
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Composite: sets access_mode to `'authenticated'` and optionally creates
   * user-isolation RLS policies for the supplied tables in one call.
   */
  async secure(params?: SecureAppParams): Promise<ButterbaseResponse<SecureAppResult>> {
    try {
      const data = await this.client.request<SecureAppResult>(
        'POST', `/v1/${this.client.appId}/secure`, params ?? {}
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}
