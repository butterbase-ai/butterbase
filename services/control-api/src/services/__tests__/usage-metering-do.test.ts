import { describe, it, expect } from 'vitest';
import type { MeterType } from '../usage-metering.js';

describe('MeterType', () => {
  it('accepts the three new DO meters', () => {
    const types: MeterType[] = ['do_requests', 'do_cpu_ms', 'do_storage_gb_seconds'];
    expect(types).toHaveLength(3);
  });

  it('still accepts the existing meters', () => {
    const types: MeterType[] = ['api_calls', 'storage_bytes', 'ai_tokens', 'lambda_invocations', 'bandwidth_bytes', 'mau'];
    expect(types).toHaveLength(6);
  });
});
