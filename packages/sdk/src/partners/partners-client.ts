import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';
import type { PartnerListItem } from './types.js';

export class PartnersClient {
  constructor(private client: ButterbaseClient) {}

  /**
   * List partner APIs configured for a specific hackathon.
   * Multiple hackathons can be open at once, so the caller must name which one.
   */
  async list(hackathonSlug: string): Promise<ButterbaseResponse<PartnerListItem[]>> {
    try {
      const data = await this.client.request<{ partners: PartnerListItem[] }>(
        'GET',
        `/v1/${this.client.appId}/partners/${encodeURIComponent(hackathonSlug)}`,
      );
      return { data: data.partners, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Forward a request to a partner API through the Butterbase proxy.
   * Returns the raw `Response` (streaming bodies pass through unchanged).
   *
   * On pool exhaustion the response is HTTP 503 with a JSON body containing
   * `error.code === 'PARTNER_QUOTA_EXHAUSTED'`. Inspect `response.ok`/`status`
   * before consuming the body.
   *
   * @param hackathonSlug  Slug of the hackathon whose pool to draw from.
   * @param slug           The partner slug, e.g. 'seedance' or 'zhipu'.
   * @param path           Path on the partner API, e.g. '/v1/video/generate'. Leading slash required.
   * @param init           Standard `fetch` init object.
   */
  async fetch(hackathonSlug: string, slug: string, path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/')) {
      throw new Error(`PartnersClient.fetch: path must begin with "/" (got "${path}")`);
    }
    const url = `${this.client.apiUrl}/v1/${this.client.appId}/partners/${encodeURIComponent(hackathonSlug)}/${encodeURIComponent(slug)}${path}`;

    const headers = new Headers(init.headers);
    const auth = this.client.getAuthHeader();
    if (auth) headers.set('Authorization', auth);

    const fetchInit: RequestInit & { duplex?: 'half' } = { ...init, headers };
    if (init.body instanceof ReadableStream) fetchInit.duplex = 'half';

    return fetch(url, fetchInit);
  }
}
