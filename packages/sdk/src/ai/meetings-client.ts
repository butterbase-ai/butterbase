// packages/sdk/src/ai/meetings-client.ts
import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type {
  StartMeetingRequest, MeetingBot, ListMeetingsOptions, ListMeetingsResult,
} from './meetings-types.js';

export class MeetingsClient {
  constructor(private readonly client: ButterbaseClient) {}

  async start(req: StartMeetingRequest): Promise<ButterbaseResponse<MeetingBot>> {
    try {
      const data = await this.client.request<MeetingBot>(
        'POST', `/v1/ai/meetings`, req,
      );
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async get(id: string): Promise<ButterbaseResponse<MeetingBot>> {
    try {
      const data = await this.client.request<MeetingBot>('GET', `/v1/ai/meetings/${id}`);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async stop(id: string): Promise<ButterbaseResponse<null>> {
    try {
      await this.client.request<null>('DELETE', `/v1/ai/meetings/${id}`);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async list(opts: ListMeetingsOptions = {}): Promise<ButterbaseResponse<ListMeetingsResult>> {
    try {
      const params = new URLSearchParams();
      if (opts.status) params.set('status', opts.status);
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.cursor) params.set('cursor', opts.cursor);
      const qs = params.toString();
      const path = `/v1/ai/meetings${qs ? `?${qs}` : ''}`;
      const data = await this.client.request<ListMeetingsResult>('GET', path);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  async estimateCost(input: { durationMinutes: number; transcript?: boolean }): Promise<ButterbaseResponse<{ usd: number }>> {
    try {
      const qs = new URLSearchParams();
      qs.set('durationMinutes', String(input.durationMinutes));
      if (input.transcript !== undefined) qs.set('transcript', String(input.transcript));
      const data = await this.client.request<{ usd: number }>('GET', `/v1/ai/meetings/_estimate?${qs.toString()}`);
      return { data, error: null };
    } catch (error) { return { data: null, error: error as Error }; }
  }
}
