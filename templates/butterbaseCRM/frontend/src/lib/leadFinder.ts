export interface SearchFilters {
  titles?: string[];
  industries?: string[];
  locations?: string[];
  seniorities?: string[];
  company_sizes?: string[];
}

export interface SearchResult {
  external_id: string;
  full_name: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  company_name?: string;
  company_domain?: string;
  linkedin_url?: string;
  location?: string;
  email_masked?: string;
  email?: string;
  email_status?: 'masked' | 'verified' | 'guessed' | 'pending' | 'unknown';
}

export interface SearchResponse {
  results: SearchResult[];
  filters: SearchFilters;
  query?: string;
  total_count: number;
  next_cursor?: string;
  query_hash: string;
  provider: 'mock' | 'apollo' | 'people_api';
  from_cache: boolean;
  usage?: { credits: number; usd: number };
}
