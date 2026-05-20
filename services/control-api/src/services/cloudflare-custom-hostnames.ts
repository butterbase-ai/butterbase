// cloudflare-custom-hostnames.ts
// Wraps the Cloudflare for SaaS (Custom Hostnames) API for managing
// user-owned domains on the butterbase.dev zone.
// This is a zone-level API, not account-level, so we cannot use cfFetch.
import { config } from '../config.js';

const ZONE_BASE = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/custom_hostnames`;

export class CustomHostnameError extends Error {
  constructor(message: string, public readonly code?: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'CustomHostnameError';
  }
}

function getHeaders(): HeadersInit {
  if (!config.cloudflare.apiToken) {
    throw new CustomHostnameError('Cloudflare API token not configured', 'MISSING_TOKEN');
  }
  return {
    'Authorization': `Bearer ${config.cloudflare.apiToken}`,
    'Content-Type': 'application/json',
  };
}

export interface CustomHostnameResult {
  id: string;
  hostname: string;
  status: string;
  ssl: {
    status: string;
    method: string;
    type: string;
    validation_records?: Array<{
      txt_name?: string;
      txt_value?: string;
      http_url?: string;
      http_body?: string;
      cname?: string;
      cname_target?: string;
    }>;
    settings?: {
      min_tls_version?: string;
    };
  };
  ownership_verification?: {
    type: string;
    name: string;
    value: string;
  };
  ownership_verification_http?: {
    http_url: string;
    http_body: string;
  };
  verification_errors?: string[];
  created_at: string;
}

interface CfResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

/**
 * Create a custom hostname on the zone via Cloudflare for SaaS.
 * SSL method defaults to 'http' (DCV over HTTP).
 * Handles 409 (already exists) idempotently.
 */
export async function createCustomHostname(hostname: string): Promise<CustomHostnameResult> {
  if (!config.cloudflare.zoneId) {
    throw new CustomHostnameError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const body = {
    hostname,
    ssl: {
      method: 'http',
      type: 'dv',
      settings: {
        min_tls_version: '1.2',
      },
    },
  };

  const response = await fetch(ZONE_BASE, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as CfResponse<CustomHostnameResult>;

  if (!response.ok) {
    const errorMessage = data.errors?.[0]?.message || response.statusText;
    const isDuplicate =
      response.status === 409 ||
      errorMessage.toLowerCase().includes('already exists') ||
      errorMessage.toLowerCase().includes('hostname already');

    if (isDuplicate) {
      // Idempotent: look up the existing hostname and return it
      const existing = await findCustomHostname(hostname);
      if (existing) return existing;
    }

    throw new CustomHostnameError(
      `Failed to create custom hostname: ${errorMessage}`,
      'CREATE_FAILED',
      response.status,
    );
  }

  return data.result;
}

/**
 * Get a custom hostname by its Cloudflare ID.
 */
export async function getCustomHostname(customHostnameId: string): Promise<CustomHostnameResult> {
  if (!config.cloudflare.zoneId) {
    throw new CustomHostnameError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const response = await fetch(`${ZONE_BASE}/${customHostnameId}`, {
    method: 'GET',
    headers: getHeaders(),
  });

  const data = (await response.json()) as CfResponse<CustomHostnameResult>;

  if (!response.ok) {
    throw new CustomHostnameError(
      `Failed to get custom hostname: ${data.errors?.[0]?.message || response.statusText}`,
      'GET_FAILED',
      response.status,
    );
  }

  return data.result;
}

/**
 * Find a custom hostname by its hostname string (for idempotency checks).
 */
export async function findCustomHostname(hostname: string): Promise<CustomHostnameResult | null> {
  if (!config.cloudflare.zoneId) {
    throw new CustomHostnameError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const response = await fetch(`${ZONE_BASE}?hostname=${encodeURIComponent(hostname)}`, {
    method: 'GET',
    headers: getHeaders(),
  });

  const data = (await response.json()) as CfResponse<CustomHostnameResult[]>;

  if (!response.ok) {
    throw new CustomHostnameError(
      `Failed to find custom hostname: ${data.errors?.[0]?.message || response.statusText}`,
      'FIND_FAILED',
      response.status,
    );
  }

  // The list endpoint returns an array; match exact hostname
  const match = (data.result as CustomHostnameResult[])?.find(
    (h) => h.hostname === hostname,
  );
  return match ?? null;
}

/**
 * Delete a custom hostname. Tolerates 404 (already deleted).
 */
export async function deleteCustomHostname(customHostnameId: string): Promise<void> {
  if (!config.cloudflare.zoneId) {
    throw new CustomHostnameError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const response = await fetch(`${ZONE_BASE}/${customHostnameId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });

  if (response.status === 404) return; // Already deleted

  if (!response.ok) {
    const data = (await response.json()) as CfResponse<unknown>;
    throw new CustomHostnameError(
      `Failed to delete custom hostname: ${data.errors?.[0]?.message || response.statusText}`,
      'DELETE_FAILED',
      response.status,
    );
  }
}

/**
 * Re-trigger validation for a custom hostname by PATCHing it.
 * This causes Cloudflare to re-check ownership and SSL status.
 */
export async function refreshCustomHostname(customHostnameId: string): Promise<CustomHostnameResult> {
  if (!config.cloudflare.zoneId) {
    throw new CustomHostnameError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const response = await fetch(`${ZONE_BASE}/${customHostnameId}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({
      ssl: {
        method: 'http',
        type: 'dv',
      },
    }),
  });

  const data = (await response.json()) as CfResponse<CustomHostnameResult>;

  if (!response.ok) {
    throw new CustomHostnameError(
      `Failed to refresh custom hostname: ${data.errors?.[0]?.message || response.statusText}`,
      'REFRESH_FAILED',
      response.status,
    );
  }

  return data.result;
}
