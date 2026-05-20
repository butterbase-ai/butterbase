// services/control-api/src/services/storage-quota.ts
import { Pool } from 'pg';
import { getRuntimeDbForApp } from './region-resolver.js';

// Constants
const DEFAULT_STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1GB default
const DEFAULT_MAX_FILE_SIZE_MB = 10;
const DEFAULT_ALLOWED_CONTENT_TYPES = ['*/*'];

export interface StorageQuota {
  maxFileSizeMb: number;
  allowedContentTypes: string[];
  publicReadEnabled: boolean;
  storageLimitBytes?: number;
}

export type QuotaCheckKind =
  | 'file_size'
  | 'content_type'
  | 'quota'
  | 'app_not_found'
  | 'config_missing'
  | 'usage_unavailable';

export interface QuotaCheckResult {
  allowed: boolean;
  kind?: QuotaCheckKind;
  reason?: string;
  currentUsageBytes?: number;
  limitBytes?: number;
  fileSizeBytes?: number;
  maxFileSizeBytes?: number;
  contentType?: string;
}

export class StorageQuotaError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export async function checkStorageQuota(
  db: Pool,
  appId: string,
  fileSizeBytes: number,
  contentType: string
): Promise<QuotaCheckResult> {
  // Input validation
  if (!appId || typeof appId !== 'string') {
    throw new StorageQuotaError('Invalid appId: must be a non-empty string', 'INVALID_APP_ID');
  }
  if (typeof fileSizeBytes !== 'number' || fileSizeBytes <= 0) {
    throw new StorageQuotaError('Invalid fileSizeBytes: must be a positive number', 'INVALID_SIZE');
  }
  if (!contentType || typeof contentType !== 'string') {
    throw new StorageQuotaError('Invalid contentType: must be a non-empty string', 'INVALID_CONTENT_TYPE');
  }

  // apps + storage_objects live in the app's home region's runtime DB.
  const runtimePool = await getRuntimeDbForApp(db, appId);

  try {
    // Get app storage config (apps is runtime-tier)
    const appResult = await runtimePool.query(
      'SELECT storage_config FROM apps WHERE id = $1',
      [appId]
    );

    if (appResult.rows.length === 0) {
      return { allowed: false, kind: 'app_not_found', reason: 'App not found' };
    }

    const storageConfig = appResult.rows[0].storage_config;

    // Validate storage_config is not null
    if (!storageConfig) {
      return { allowed: false, kind: 'config_missing', reason: 'Storage configuration not found for app' };
    }

    // Safely extract config values with defaults
    const config: StorageQuota = {
      maxFileSizeMb: storageConfig.maxFileSizeMb ?? DEFAULT_MAX_FILE_SIZE_MB,
      allowedContentTypes: storageConfig.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES,
      publicReadEnabled: storageConfig.publicReadEnabled ?? false,
      storageLimitBytes: storageConfig.storageLimitBytes ?? DEFAULT_STORAGE_LIMIT_BYTES,
    };

    // Check file size limit
    const maxBytes = config.maxFileSizeMb * 1024 * 1024;
    if (fileSizeBytes > maxBytes) {
      return {
        allowed: false,
        kind: 'file_size',
        reason: `File size ${fileSizeBytes} bytes exceeds per-file limit of ${maxBytes} bytes (${config.maxFileSizeMb} MB)`,
        fileSizeBytes,
        maxFileSizeBytes: maxBytes,
      };
    }

    // Check content type
    const isAllowed = config.allowedContentTypes.includes('*/*') ||
      config.allowedContentTypes.some(allowed => {
        if (allowed.endsWith('/*')) {
          const prefix = allowed.slice(0, -2);
          return contentType.startsWith(prefix);
        }
        return contentType === allowed;
      });

    if (!isAllowed) {
      return {
        allowed: false,
        kind: 'content_type',
        reason: `Content type ${contentType} not allowed`,
        contentType,
      };
    }

    // Check total storage quota (storage_objects is runtime-tier)
    const usageResult = await runtimePool.query(
      'SELECT COALESCE(SUM(size_bytes), 0) as total FROM storage_objects WHERE app_id = $1',
      [appId]
    );

    if (!usageResult.rows || usageResult.rows.length === 0) {
      return { allowed: false, kind: 'usage_unavailable', reason: 'Failed to retrieve storage usage' };
    }

    const currentUsage = parseInt(usageResult.rows[0].total, 10);
    if (isNaN(currentUsage)) {
      return { allowed: false, kind: 'usage_unavailable', reason: 'Invalid storage usage data' };
    }

    const storageLimit = config.storageLimitBytes ?? DEFAULT_STORAGE_LIMIT_BYTES;

    if (currentUsage + fileSizeBytes > storageLimit) {
      return {
        allowed: false,
        kind: 'quota',
        reason: 'Storage quota exceeded',
        currentUsageBytes: currentUsage,
        limitBytes: storageLimit,
        fileSizeBytes,
      };
    }

    return { allowed: true };
  } catch (error) {
    if (error instanceof StorageQuotaError) {
      throw error;
    }
    throw new StorageQuotaError(
      `Failed to check storage quota: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'QUOTA_CHECK_FAILED'
    );
  }
}
