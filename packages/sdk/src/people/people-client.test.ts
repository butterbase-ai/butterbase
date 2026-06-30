import { describe, it, expect } from 'vitest';
import { PeopleClient } from './people-client';

const defaultHeaders = {
  'x-people-provider': 'secondary',
  'x-people-credits-consumed': '6',
  'x-people-usd-cost': '0.12',
  'x-people-usd-charged': '0.10',
};

function fakeClient(body: unknown, headers: Record<string, string> = defaultHeaders) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fc: any = {
    appId: 'app_test',
    requestRaw: (method: string, path: string, reqBody?: unknown) => {
      calls.push({ method, path, body: reqBody });
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers }));
    },
  };
  return { fc, calls };
}

function fakeClientThrows(error: Error) {
  const fc: any = {
    appId: 'app_test',
    requestRaw: () => { throw error; },
  };
  return { fc };
}

describe('PeopleClient', () => {
  // Scenario 1: searchPerson POSTs to correct URL; returns data, usage, meta with headers parsed
  it('searchPerson POSTs to /v1/app_test/people/search/person and parses meta', async () => {
    const responseBody = {
      data: { results: [], nextPage: null, totalResultCount: 0 },
      usage: { creditsConsumed: 6, usdCost: 0.12, usdCharged: 0.10 },
    };
    const { fc, calls } = fakeClient(responseBody);
    const result = await new PeopleClient(fc).searchPerson({ currentRoleTitle: 'CTO', country: 'US' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/v1/app_test/people/search/person');
    expect(calls[0].body).toEqual({ currentRoleTitle: 'CTO', country: 'US' });
    expect(result.data).toEqual(responseBody.data);
    expect(result.usage).toEqual(responseBody.usage);
    expect(result.meta.provider).toBe('secondary');
    expect(result.meta.creditsConsumed).toBe(6);
    expect(result.meta.usdCost).toBeCloseTo(0.12);
    expect(result.meta.usdCharged).toBeCloseTo(0.10);
  });

  // Scenario 2: searchPerson with query field forwards it in request body
  it('searchPerson forwards query field in request body', async () => {
    const responseBody = {
      data: { results: [], nextPage: null, totalResultCount: 0 },
      usage: { creditsConsumed: 3 },
    };
    const { fc, calls } = fakeClient(responseBody);
    await new PeopleClient(fc).searchPerson({ query: 'CTOs in San Francisco' });

    expect(calls[0].body).toEqual({ query: 'CTOs in San Francisco' });
  });

  // Scenario 3: searchCompany POSTs to correct URL; meta parsed correctly
  it('searchCompany POSTs to /v1/app_test/people/search/company and parses meta', async () => {
    const responseBody = {
      data: { results: [], nextPage: null, totalResultCount: 0 },
      usage: { creditsConsumed: 6 },
    };
    const { fc, calls } = fakeClient(responseBody);
    const result = await new PeopleClient(fc).searchCompany({ industry: 'SaaS', country: 'US' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/v1/app_test/people/search/company');
    expect(calls[0].body).toEqual({ industry: 'SaaS', country: 'US' });
    expect(result.meta.provider).toBe('secondary');
    expect(result.meta.creditsConsumed).toBe(6);
  });

  // Scenario 4: getProfile; meta.cached = true when x-people-cached: true header present
  it('getProfile sets meta.cached = true when x-people-cached header is "true"', async () => {
    const responseBody = {
      data: null,
      usage: { creditsConsumed: 0, cached: true },
    };
    const { fc } = fakeClient(responseBody, { ...defaultHeaders, 'x-people-cached': 'true' });
    const result = await new PeopleClient(fc).getProfile({ linkedinProfileUrl: 'https://linkedin.com/in/test' });

    expect(result.meta.cached).toBe(true);
  });

  // Scenario 5: getProfile; meta.cached = false when x-people-cached: false header present
  it('getProfile sets meta.cached = false when x-people-cached header is "false"', async () => {
    const responseBody = {
      data: null,
      usage: { creditsConsumed: 1 },
    };
    const { fc } = fakeClient(responseBody, { ...defaultHeaders, 'x-people-cached': 'false' });
    const result = await new PeopleClient(fc).getProfile({ linkedinProfileUrl: 'https://linkedin.com/in/test' });

    expect(result.meta.cached).toBe(false);
  });

  // Scenario 6: getProfile with no x-people-cached header → meta.cached is undefined
  it('getProfile leaves meta.cached undefined when x-people-cached header is absent', async () => {
    const responseBody = {
      data: null,
      usage: { creditsConsumed: 1 },
    };
    // Use headers without x-people-cached
    const headersNoCached = {
      'x-people-provider': 'primary',
      'x-people-credits-consumed': '1',
      'x-people-usd-cost': '0.05',
      'x-people-usd-charged': '0.05',
    };
    const { fc } = fakeClient(responseBody, headersNoCached);
    const result = await new PeopleClient(fc).getProfile({ linkedinProfileUrl: 'https://linkedin.com/in/test' });

    expect(result.meta.cached).toBeUndefined();
  });

  // Scenario 7: queueEmailLookup POSTs to correct URL; returns data.lookupId and data.status
  it('queueEmailLookup POSTs to correct URL and returns lookupId and status', async () => {
    const responseBody = {
      lookupId: 'lookup_abc123',
      status: 'pending',
      usage: { creditsConsumed: 2 },
    };
    const { fc, calls } = fakeClient(responseBody);
    const result = await new PeopleClient(fc).queueEmailLookup({ linkedinProfileUrl: 'https://linkedin.com/in/test' });

    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/v1/app_test/people/profile/email');
    expect(result.data.lookupId).toBe('lookup_abc123');
    expect(result.data.status).toBe('pending');
    expect(result.usage.creditsConsumed).toBe(2);
  });

  // Scenario 8: getEmailLookup GETs correct URL; returns data.status and data.email
  it('getEmailLookup GETs /v1/app_test/people/email-lookup/<id> and returns status and email', async () => {
    const responseBody: { status: string; email: string | null; creditsConsumed: number | null } = {
      status: 'completed',
      email: 'test@mock.com',
      creditsConsumed: 5,
    };
    const { fc, calls } = fakeClient(responseBody);
    const result = await new PeopleClient(fc).getEmailLookup('lookup_abc123');

    expect(calls[0].method).toBe('GET');
    expect(calls[0].path).toBe('/v1/app_test/people/email-lookup/lookup_abc123');
    expect(result.data.status).toBe('completed');
    expect(result.data.email).toBe('test@mock.com');
  });

  // Scenario 9: Error path — requestRaw throws → searchPerson propagates it
  it('searchPerson propagates errors thrown by requestRaw', async () => {
    const error = new Error('API error: 422');
    const { fc } = fakeClientThrows(error);

    await expect(new PeopleClient(fc).searchPerson({ country: 'US' })).rejects.toThrow('API error: 422');
  });
});
