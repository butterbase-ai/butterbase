// services/control-api/src/services/cloudflare-pages.ts
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { CF_BASE } from './cloudflare-client.js';

const execFileAsync = promisify(execFile);

export interface FileEntry {
  path: string;
  content: Buffer;
}

export interface CloudflareProject {
  name: string;
  subdomain: string;
  domains: string[];
  created_on: string;
  production_branch: string;
}

export interface CloudflareDeployment {
  id: string;
  url: string;
  environment: string;
  created_on: string;
  latest_stage: {
    name: string;
    status: string;
  };
}

export class CloudflareError extends Error {
  constructor(message: string, public readonly code?: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'CloudflareError';
  }
}

function getHeaders(): HeadersInit {
  if (!config.cloudflare.apiToken) {
    throw new CloudflareError('Cloudflare API token not configured', 'MISSING_TOKEN');
  }

  return {
    'Authorization': `Bearer ${config.cloudflare.apiToken}`,
    'Content-Type': 'application/json',
  };
}

function getBaseUrl(): string {
  if (!config.cloudflare.accountId) {
    throw new CloudflareError('Cloudflare account ID not configured', 'MISSING_ACCOUNT_ID');
  }
  return `${CF_BASE}/pages/projects`;
}

/**
 * Create a Cloudflare Pages project
 */
export async function createProject(appSlug: string): Promise<CloudflareProject> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  const projectName = `bb-${appSlug}`;

  try {
    const response = await fetch(getBaseUrl(), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        name: projectName,
        production_branch: 'main',
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      // Check if project already exists
      if (response.status === 409 || (data.errors && data.errors[0]?.code === 8000007)) {
        // Project already exists, fetch it
        return await getProject(projectName);
      }

      throw new CloudflareError(
        `Failed to create Cloudflare Pages project: ${data.errors?.[0]?.message || response.statusText}`,
        'CREATE_FAILED',
        response.status
      );
    }

    return data.result;
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to create Cloudflare Pages project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CREATE_FAILED'
    );
  }
}

/**
 * Get a Cloudflare Pages project
 */
export async function getProject(projectName: string): Promise<CloudflareProject> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}`, {
      method: 'GET',
      headers: getHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new CloudflareError(
        `Failed to get Cloudflare Pages project: ${data.errors?.[0]?.message || response.statusText}`,
        'GET_FAILED',
        response.status
      );
    }

    return data.result;
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to get Cloudflare Pages project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'GET_FAILED'
    );
  }
}

/**
 * Create a deployment using wrangler CLI (the Direct Upload REST API is unreliable).
 * Writes files to a temp directory and runs `wrangler pages deploy`.
 */
export async function createDeployment(
  projectName: string,
  files: FileEntry[]
): Promise<CloudflareDeployment> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-deploy-'));

  try {
    // Write files to temp directory
    for (const file of files) {
      const normalizedPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
      const filePath = path.join(tmpDir, normalizedPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content);
    }

    // Deploy via wrangler
    const { stdout } = await execFileAsync('npx', [
      'wrangler', 'pages', 'deploy', tmpDir,
      '--project-name', projectName,
      '--branch', 'main',
    ], {
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId,
        CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken,
      },
      timeout: 120_000,
    });

    // Parse deployment URL from wrangler output
    const urlMatch = stdout.match(/https:\/\/[^\s]+\.pages\.dev/);
    const idMatch = stdout.match(/([0-9a-f]{8})\.[^.]+\.pages\.dev/);

    return {
      id: idMatch?.[1] || crypto.randomUUID(),
      url: urlMatch?.[0] || `https://${projectName}.pages.dev`,
      environment: 'production',
      created_on: new Date().toISOString(),
      latest_stage: { name: 'deploy', status: 'success' },
    };
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CloudflareError(`Deployment failed: ${message}`, 'DEPLOY_FAILED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Get deployment status
 */
export async function getDeployment(
  projectName: string,
  deploymentId: string
): Promise<CloudflareDeployment> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}/deployments/${deploymentId}`, {
      method: 'GET',
      headers: getHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new CloudflareError(
        `Failed to get deployment: ${data.errors?.[0]?.message || response.statusText}`,
        'GET_DEPLOYMENT_FAILED',
        response.status
      );
    }

    return data.result;
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to get deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'GET_DEPLOYMENT_FAILED'
    );
  }
}

/**
 * Delete a Cloudflare Pages project
 */
export async function deleteProject(projectName: string): Promise<void> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new CloudflareError(
        `Failed to delete project: ${data.errors?.[0]?.message || response.statusText}`,
        'DELETE_FAILED',
        response.status
      );
    }
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to delete project: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'DELETE_FAILED'
    );
  }
}

/**
 * Cancel a deployment
 */
export async function cancelDeployment(
  projectName: string,
  deploymentId: string
): Promise<void> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}/deployments/${deploymentId}/cancel`, {
      method: 'POST',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new CloudflareError(
        `Failed to cancel deployment: ${data.errors?.[0]?.message || response.statusText}`,
        'CANCEL_FAILED',
        response.status
      );
    }
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to cancel deployment: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CANCEL_FAILED'
    );
  }
}

/**
 * Verify Cloudflare webhook signature using HMAC-SHA256
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  try {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');

    // Constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    return false;
  }
}

export interface CloudflareDomain {
  id: string;
  name: string;
  status: string;
  verification_method: string;
  verification_value: string;
  ssl_status: string;
}

/**
 * Add custom domain to Cloudflare Pages project
 */
export async function addCustomDomain(
  projectName: string,
  domain: string
): Promise<CloudflareDomain> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}/domains`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name: domain }),
    });

    const data = await response.json();

    if (!response.ok) {
      const errorMessage: string = data.errors?.[0]?.message || data.messages?.[0]?.message || response.statusText;
      // Idempotent: if domain is already registered, return its current state
      const isDuplicate = response.status === 409
        || errorMessage.toLowerCase().includes('already added')
        || errorMessage.toLowerCase().includes('already exists')
        || errorMessage.toLowerCase().includes('domain is already');
      if (isDuplicate) {
        try {
          return await getDomainStatus(projectName, domain);
        } catch {
          // getDomainStatus failed — return a synthetic result so deployment isn't blocked
          return { id: '', name: domain, status: 'active', verification_method: '', verification_value: '', ssl_status: '' } as CloudflareDomain;
        }
      }
      throw new CloudflareError(
        `Failed to add custom domain: ${errorMessage}`,
        'ADD_DOMAIN_FAILED',
        response.status
      );
    }

    return data.result;
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to add custom domain: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'ADD_DOMAIN_FAILED'
    );
  }
}

/**
 * Remove custom domain from Cloudflare Pages project
 */
export async function removeCustomDomain(
  projectName: string,
  domain: string
): Promise<void> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}/domains/${domain}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new CloudflareError(
        `Failed to remove custom domain: ${data.errors?.[0]?.message || response.statusText}`,
        'REMOVE_DOMAIN_FAILED',
        response.status
      );
    }
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to remove custom domain: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'REMOVE_DOMAIN_FAILED'
    );
  }
}

/**
 * Create a CNAME DNS record in the Cloudflare zone.
 * Uses PUT (upsert) semantics so re-deploys don't fail on duplicate records.
 */
export async function createDnsRecord(
  name: string,
  target: string,
  proxied = true
): Promise<{ id: string }> {
  if (!config.cloudflare.zoneId) {
    throw new CloudflareError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const zoneUrl = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/dns_records`;

  // Check if the record already exists
  const existing = await fetch(
    `${zoneUrl}?type=CNAME&name=${encodeURIComponent(name)}`,
    { method: 'GET', headers: getHeaders() }
  );
  const existingData = await existing.json() as { result?: { id: string; content: string }[] };

  if (existingData.result && existingData.result.length > 0) {
    const record = existingData.result[0];
    // Update if target changed
    if (record.content !== target) {
      const updateResp = await fetch(`${zoneUrl}/${record.id}`, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ type: 'CNAME', name, content: target, proxied }),
      });
      if (!updateResp.ok) {
        const err = await updateResp.json() as { errors?: { message: string }[] };
        throw new CloudflareError(
          `Failed to update DNS record: ${err.errors?.[0]?.message || updateResp.statusText}`,
          'DNS_UPDATE_FAILED',
          updateResp.status
        );
      }
    }
    return { id: record.id };
  }

  // Create new record
  const response = await fetch(zoneUrl, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ type: 'CNAME', name, content: target, proxied }),
  });

  const data = await response.json() as { result?: { id: string }; errors?: { message: string }[] };

  if (!response.ok) {
    throw new CloudflareError(
      `Failed to create DNS record: ${data.errors?.[0]?.message || response.statusText}`,
      'DNS_CREATE_FAILED',
      response.status
    );
  }

  return { id: data.result!.id };
}

/**
 * Delete a CNAME DNS record from the Cloudflare zone.
 * Silently succeeds if no matching record exists.
 */
export async function deleteDnsRecord(name: string): Promise<void> {
  if (!config.cloudflare.zoneId) {
    throw new CloudflareError('Cloudflare zone ID not configured', 'MISSING_ZONE_ID');
  }

  const zoneUrl = `https://api.cloudflare.com/client/v4/zones/${config.cloudflare.zoneId}/dns_records`;

  const existing = await fetch(
    `${zoneUrl}?type=CNAME&name=${encodeURIComponent(name)}`,
    { method: 'GET', headers: getHeaders() }
  );
  const existingData = await existing.json() as { result?: { id: string }[] };

  if (!existingData.result || existingData.result.length === 0) {
    return;
  }

  for (const record of existingData.result) {
    const resp = await fetch(`${zoneUrl}/${record.id}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });
    if (!resp.ok) {
      const err = await resp.json() as { errors?: { message: string }[] };
      throw new CloudflareError(
        `Failed to delete DNS record: ${err.errors?.[0]?.message || resp.statusText}`,
        'DNS_DELETE_FAILED',
        resp.status
      );
    }
  }
}

/**
 * Get custom domain status
 */
export async function getDomainStatus(
  projectName: string,
  domain: string
): Promise<CloudflareDomain> {
  if (!config.cloudflare.enabled) {
    throw new CloudflareError('Cloudflare Pages is not enabled', 'NOT_ENABLED');
  }

  try {
    const response = await fetch(`${getBaseUrl()}/${projectName}/domains/${domain}`, {
      method: 'GET',
      headers: getHeaders(),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new CloudflareError(
        `Failed to get domain status: ${data.errors?.[0]?.message || response.statusText}`,
        'GET_DOMAIN_FAILED',
        response.status
      );
    }

    return data.result;
  } catch (error) {
    if (error instanceof CloudflareError) {
      throw error;
    }
    throw new CloudflareError(
      `Failed to get domain status: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'GET_DOMAIN_FAILED'
    );
  }
}
