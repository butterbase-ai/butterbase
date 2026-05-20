import { getRedisPubClient } from '../services/redis.js';

export interface InvalidationResult {
  success: boolean;
  attempts: number;
  error?: string;
  duration_ms: number;
}

export async function invalidateFunctionCache(
  appId: string,
  functionName: string,
): Promise<InvalidationResult> {
  const startTime = Date.now();
  try {
    const redis = getRedisPubClient();
    await redis.publish(
      'function:invalidate',
      JSON.stringify({ app_id: appId, function_name: functionName }),
    );
    return { success: true, attempts: 1, duration_ms: Date.now() - startTime };
  } catch (error) {
    console.error('Cache invalidation publish failed:', error);
    return {
      success: false,
      attempts: 1,
      error: (error as Error).message,
      duration_ms: Date.now() - startTime,
    };
  }
}
