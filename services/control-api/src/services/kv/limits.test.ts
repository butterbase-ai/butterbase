import { describe, it, expect } from 'vitest';
import type { PlanLimits } from '../plugins/quota-enforcement.js';

// Unit test for KvLimits interface and extraction logic
describe('KvLimits extraction', () => {
  function extractKvLimits(allLimits: PlanLimits) {
    return {
      maxOpsPerSec: allLimits.kvMaxOpsPerSec,
      maxStorageBytes: allLimits.kvMaxStorageBytes,
      maxKeysTotal: allLimits.kvMaxKeysTotal,
      maxValueBytes: allLimits.kvMaxValueBytes,
    };
  }

  it('extracts KV limits from playground-tier plan', () => {
    const playgroundLimits: PlanLimits = {
      maxStorageGb: 1,
      maxAiCreditsUsd: 5,
      aiCreditsLifetime: true,
      maxLambdaInvocations: 50000,
      maxBandwidthGb: 5,
      maxDbSizeGb: 0.5,
      maxMau: 10000,
      defaultSpendingCapUsd: null,
      aiOverageRateUsd: null,
      maxRequestsPerMin: 300,
      maxRealtimeListenersPerApp: 20,
      statementTimeoutMs: 15000,
      kvMaxOpsPerSec: 50,
      kvMaxStorageBytes: 10 * 1024 * 1024,
      kvMaxKeysTotal: 100_000,
      kvMaxValueBytes: 256 * 1024,
    };

    const limits = extractKvLimits(playgroundLimits);

    expect(limits.maxOpsPerSec).toBe(50);
    expect(limits.maxStorageBytes).toBe(10 * 1024 * 1024);
    expect(limits.maxKeysTotal).toBe(100_000);
    expect(limits.maxValueBytes).toBe(256 * 1024);
  });

  it('extracts KV limits from paid-tier (launch) plan', () => {
    const paidLimits: PlanLimits = {
      maxStorageGb: 10,
      maxAiCreditsUsd: 50,
      aiCreditsLifetime: false,
      maxLambdaInvocations: 500000,
      maxBandwidthGb: 50,
      maxDbSizeGb: 5,
      maxMau: 100000,
      defaultSpendingCapUsd: 20,
      aiOverageRateUsd: 0.01,
      maxRequestsPerMin: 3000,
      maxRealtimeListenersPerApp: 200,
      statementTimeoutMs: 30000,
      kvMaxOpsPerSec: 1000,
      kvMaxStorageBytes: 1073741824, // 1 GB
      kvMaxKeysTotal: 1000000,
      kvMaxValueBytes: 256 * 1024,
    };

    const limits = extractKvLimits(paidLimits);

    expect(limits.maxOpsPerSec).toBe(1000);
    expect(limits.maxStorageBytes).toBe(1073741824);
    expect(limits.maxKeysTotal).toBe(1000000);
    expect(limits.maxValueBytes).toBe(256 * 1024);
  });
});
