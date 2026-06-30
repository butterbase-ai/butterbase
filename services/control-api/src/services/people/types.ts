export interface SearchPersonRequest {
  currentRoleTitle?: string;        // supports boolean syntax: (CTO OR "VP Engineering") AND NOT intern
  pastRoleTitle?: string;
  currentCompanyName?: string;
  currentCompanyIndustry?: string;
  country?: string;
  region?: string;
  city?: string;
  // Education filters — boolean syntax supported, e.g.
  //   educationSchoolName: '(Harvard OR Stanford OR MIT)'
  //   educationDegreeName: 'MBA'
  //   educationFieldOfStudy: '"Computer Science"'
  educationSchoolName?: string;
  educationDegreeName?: string;
  educationFieldOfStudy?: string;
  pageSize?: number;                // capped at 100 in route layer
  nextToken?: string;
  enrichProfiles?: boolean;         // true → enrich_profiles=enrich (costs more, returns full profile)
  // Raw NL query passthrough — when set, takes priority over structured fields (Exa slot only).
  query?: string;
}

export interface SearchPersonResult {
  linkedinProfileUrl: string;
  profile: ProfilePayload | null;   // populated when enrichProfiles=true
  lastUpdated: string | null;
}

export interface SearchPersonResponse {
  results: SearchPersonResult[];
  nextPage: string | null;
  totalResultCount: number;
}

export interface SearchCompanyRequest {
  industry?: string;
  country?: string;
  employeeCountMax?: number;
  pageSize?: number;
  nextToken?: string;
  enrichProfiles?: boolean;
  // Raw NL query passthrough — when set, takes priority over structured fields (Exa slot only).
  query?: string;
}

export interface CompanyPayload {
  linkedinUrl: string;
  name: string | null;
  industry: string | null;
  country: string | null;
  employeeCount: number | null;
}

export interface SearchCompanyResponse {
  results: CompanyPayload[];
  nextPage: string | null;
  totalResultCount: number;
}

export interface GetProfileRequest {
  linkedinProfileUrl: string;
  useCache?: 'if-recent' | 'never';   // default 'if-recent' in adapter
  liveFetch?: 'force';                  // off by default
  extra?: 'include';
}

export interface ProfilePayload {
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  headline: string | null;
  occupation: string | null;
  summary: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  experiences: unknown[];
  education: unknown[];
  raw: unknown;                         // verbatim People body, for cache + future migrations
}

export interface QueueEmailRequest {
  linkedinProfileUrl: string;
  callbackUrl: string;                  // route builds this with nonce
}

export interface EnrichResult<T> {
  data: T;
  creditsConsumed: number;
  requestId: string | null;
  status: number;
  notFound?: boolean;
}

export interface PeopleAdapter {
  searchPerson(q: SearchPersonRequest, opts: { apiKey: string }): Promise<EnrichResult<SearchPersonResponse>>;
  searchCompany(q: SearchCompanyRequest, opts: { apiKey: string }): Promise<EnrichResult<SearchCompanyResponse>>;
  getProfile(req: GetProfileRequest, opts: { apiKey: string }): Promise<EnrichResult<ProfilePayload | null>>;
  queueEmailLookup(req: QueueEmailRequest, opts: { apiKey: string }): Promise<EnrichResult<{ queued: true }>>;
}

export class PeopleError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'PeopleError';
  }
}

export type ProviderSlot = 'primary' | 'secondary';

export class PeopleProviderError extends Error {
  constructor(
    public readonly code: 'action_unsupported_by_slot' | 'provider_not_registered',
    message: string,
  ) {
    super(message);
    this.name = 'PeopleProviderError';
  }
}
