import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type {
  SearchPersonRequest,
  SearchPersonResponse,
  SearchCompanyRequest,
  SearchCompanyResponse,
  ProfilePayload,
  PeopleMeta,
  PeopleUsage,
  EmailLookupResult,
} from './types.js';

/**
 * Parse `x-people-*` response headers into a {@link PeopleMeta} object.
 * All headers are expected to be present on every people endpoint response.
 */
function parsePeopleMeta(headers: Headers): PeopleMeta {
  const meta: PeopleMeta = {
    provider: (headers.get('x-people-provider') ?? 'primary') as 'primary' | 'secondary',
    creditsConsumed: parseInt(headers.get('x-people-credits-consumed') ?? '0', 10),
    usdCost: parseFloat(headers.get('x-people-usd-cost') ?? '0'),
    usdCharged: parseFloat(headers.get('x-people-usd-charged') ?? '0'),
  };
  const cachedHeader = headers.get('x-people-cached');
  if (cachedHeader !== null) {
    meta.cached = cachedHeader === 'true';
  }
  return meta;
}

/**
 * Client for the People search and enrichment endpoints.
 *
 * Obtain an instance via `client.people`:
 * ```ts
 * const butterbase = createClient({ appId: '...', apiUrl: '...', anonKey: '...' });
 * const { data, usage, meta } = await butterbase.people.searchPerson({ currentRoleTitle: 'CTO', country: 'US' });
 * ```
 *
 * Methods throw a typed {@link ButterbaseError} on API errors (4xx / 5xx).
 */
export class PeopleClient {
  constructor(private readonly client: ButterbaseClient) {}

  /**
   * Search for people matching the given criteria.
   * Supports both structured fields and a raw natural-language `query`.
   */
  async searchPerson(
    req: SearchPersonRequest,
  ): Promise<{ data: SearchPersonResponse; usage: PeopleUsage; meta: PeopleMeta }> {
    const res = await this.client.requestRaw(
      'POST',
      `/v1/${this.client.appId}/people/search/person`,
      req,
    );
    const body = await res.json() as { data: SearchPersonResponse; usage: PeopleUsage };
    return { data: body.data, usage: body.usage, meta: parsePeopleMeta(res.headers) };
  }

  /**
   * Search for companies matching the given criteria.
   * Supports both structured fields and a raw natural-language `query`.
   */
  async searchCompany(
    req: SearchCompanyRequest,
  ): Promise<{ data: SearchCompanyResponse; usage: PeopleUsage; meta: PeopleMeta }> {
    const res = await this.client.requestRaw(
      'POST',
      `/v1/${this.client.appId}/people/search/company`,
      req,
    );
    const body = await res.json() as { data: SearchCompanyResponse; usage: PeopleUsage };
    return { data: body.data, usage: body.usage, meta: parsePeopleMeta(res.headers) };
  }

  /**
   * Fetch the LinkedIn profile for a given URL.
   * Results are cached server-side; use `liveFetch: 'force'` to bypass the cache.
   */
  async getProfile(req: {
    linkedinProfileUrl: string;
    liveFetch?: 'auto' | 'force';
  }): Promise<{ data: ProfilePayload | null; usage: PeopleUsage; meta: PeopleMeta }> {
    const res = await this.client.requestRaw(
      'POST',
      `/v1/${this.client.appId}/people/profile`,
      req,
    );
    const body = await res.json() as { data: ProfilePayload | null; usage: PeopleUsage };
    return { data: body.data, usage: body.usage, meta: parsePeopleMeta(res.headers) };
  }

  /**
   * Queue an asynchronous email-address lookup for a LinkedIn profile.
   * Returns a `lookupId` that can be polled with {@link getEmailLookup}.
   */
  async queueEmailLookup(
    req: { linkedinProfileUrl: string },
  ): Promise<{ data: { lookupId: string; status: string }; usage: PeopleUsage; meta: PeopleMeta }> {
    const res = await this.client.requestRaw(
      'POST',
      `/v1/${this.client.appId}/people/profile/email`,
      req,
    );
    const body = await res.json() as { lookupId: string; status: string; usage: PeopleUsage };
    return {
      data: { lookupId: body.lookupId, status: body.status },
      usage: body.usage,
      meta: parsePeopleMeta(res.headers),
    };
  }

  /**
   * Poll the status of an email-address lookup previously started with
   * {@link queueEmailLookup}.
   */
  async getEmailLookup(
    lookupId: string,
  ): Promise<{ data: EmailLookupResult; meta: PeopleMeta }> {
    const res = await this.client.requestRaw(
      'GET',
      `/v1/${this.client.appId}/people/email-lookup/${encodeURIComponent(lookupId)}`,
    );
    const body = await res.json() as EmailLookupResult;
    return { data: body, meta: parsePeopleMeta(res.headers) };
  }
}
