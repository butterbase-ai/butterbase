import type { Pool } from 'pg';
import { getLimitsForApp } from '../app-plan-resolver.js';

export interface KvLimits {
  maxOpsPerSec: number;
  maxStorageBytes: number;
  maxKeysTotal: number;
  maxValueBytes: number;
}

export async function getKvLimitsForApp(
  controlDb: Pool,
  appId: string
): Promise<KvLimits> {
  const all = await getLimitsForApp(controlDb, appId);
  return {
    maxOpsPerSec: all.kvMaxOpsPerSec,
    maxStorageBytes: all.kvMaxStorageBytes,
    maxKeysTotal: all.kvMaxKeysTotal,
    maxValueBytes: all.kvMaxValueBytes,
  };
}
