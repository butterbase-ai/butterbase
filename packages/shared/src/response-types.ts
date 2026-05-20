// packages/shared/src/response-types.ts

/**
 * Next action suggestion for agents
 */
export interface NextAction {
  action: string;
  description: string;
  recommended: boolean;
}

/**
 * Resource usage information
 */
export interface ResourceInfo {
  quota_used?: number;
  quota_limit?: number;
  rate_limit_remaining?: number;
  /** Storage used in bytes */
  storage_used_bytes?: number;
  /** Storage limit in bytes */
  storage_limit_bytes?: number;
  /** Storage used as percentage (0-100) */
  storage_used_percent?: number;
  /** Number of files stored */
  files_count?: number;
  /** Number of tables in database */
  tables_count?: number;
  /** Maximum tables allowed */
  tables_limit?: number;
}

/**
 * Response metadata for agent guidance
 */
export interface ResponseMetadata {
  next_actions?: NextAction[];
  resource_info?: ResourceInfo;
}

/**
 * Generic response wrapper with metadata
 */
export type ResponseWithMetadata<T> = T & { _meta?: ResponseMetadata; }
