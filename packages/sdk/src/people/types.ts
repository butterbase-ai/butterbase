// Types mirroring the people search/enrich HTTP layer.
// Internal provider types (PeopleAdapter, PeopleError, etc.) are not exported.

export interface SearchPersonRequest {
  currentRoleTitle?: string;
  pastRoleTitle?: string;
  currentCompanyName?: string;
  currentCompanyIndustry?: string;
  country?: string;
  region?: string;
  city?: string;
  educationSchoolName?: string;
  educationDegreeName?: string;
  educationFieldOfStudy?: string;
  pageSize?: number;
  nextToken?: string;
  enrichProfiles?: boolean;
  /** Raw natural-language query — when set, takes priority over all structured fields. */
  query?: string;
}

export interface SearchPersonResult {
  linkedinProfileUrl: string;
  profile: ProfilePayload | null;
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
  /** Raw natural-language query — when set, takes priority over all structured fields. */
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
  skills?: string[];
  languages?: string[];
  profilePicUrl?: string | null;
  raw: unknown;
}

/**
 * Billing and provider metadata extracted from response headers on every
 * people endpoint. Maps `x-people-*` response headers.
 */
export interface PeopleMeta {
  /** Which provider slot handled this request. */
  provider: 'primary' | 'secondary';
  /** Credits deducted from the account balance for this request. */
  creditsConsumed: number;
  /** Raw USD cost of this request (before any discount). */
  usdCost: number;
  /** USD actually charged to the account after any free-tier offsets. */
  usdCharged: number;
  /** Present on profile responses; true when returned from the local cache. */
  cached?: boolean;
}

/** Usage summary included in every people response body. */
export interface PeopleUsage {
  creditsConsumed: number;
  usdCost?: number;
  usdCharged?: number;
  /** Present on profile responses. */
  cached?: boolean;
}

/** Result of a GET /people/email-lookup/:id call. */
export interface EmailLookupResult {
  status: string;
  email: string | null;
  creditsConsumed: number | null;
}
