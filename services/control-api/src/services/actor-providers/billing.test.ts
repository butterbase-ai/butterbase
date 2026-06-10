// billing.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reserveActorCredits, settleActorCall, FLOOR_LEASE_SECONDS } from './billing.js';
import { InsufficientCreditsError } from '../ai-router/billing-gate.js';

vi.mock('../lease-service.js', () => ({
  grantLease: vi.fn(),
  settleLease: vi.fn(),
}));

import { grantLease, settleLease } from '../lease-service.js';
const grantLeaseMock = grantLease as unknown as ReturnType<typeof vi.fn>;
const settleLeaseMock = settleLease as unknown as ReturnType<typeof vi.fn>;

const POOL = {} as any;
const NOW = new Date('2026-06-11T00:00:00Z');

describe('reserveActorCredits', () => {
  it('leases the floor-seconds * (recording+transcription)/sec when transcript=true', async () => {
    grantLeaseMock.mockResolvedValueOnce({
      leaseId: 'lease_1', amountGranted: 0.0542, expiresAt: NOW,
    });
    const handle = await reserveActorCredits(POOL, {
      userId: 'u', region: 'us-east-1',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0.0000416,
      transcript: true,
      markupPct: 0,
    });
    expect(grantLeaseMock).toHaveBeenCalledWith(POOL, expect.objectContaining({
      userId: 'u',
      amountUsd: expect.closeTo(0.05412, 4),
    }));
    expect(handle.leaseId).toBe('lease_1');
  });

  it('skips transcription cost when transcript=false', async () => {
    grantLeaseMock.mockResolvedValueOnce({
      leaseId: 'lease_2', amountGranted: 0.0417, expiresAt: NOW,
    });
    await reserveActorCredits(POOL, {
      userId: 'u', region: 'us-east-1',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0.0000416,
      transcript: false,
      markupPct: 0,
    });
    expect(grantLeaseMock).toHaveBeenCalledWith(POOL, expect.objectContaining({
      amountUsd: expect.closeTo(0.04164, 4),
    }));
  });

  it('applies markup to the lease amount', async () => {
    grantLeaseMock.mockResolvedValueOnce({
      leaseId: 'lease_3', amountGranted: 1, expiresAt: NOW,
    });
    await reserveActorCredits(POOL, {
      userId: 'u', region: 'us-east-1',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0,
      transcript: false,
      markupPct: 30,
    });
    expect(grantLeaseMock).toHaveBeenCalledWith(POOL, expect.objectContaining({
      amountUsd: expect.closeTo(0.054132, 4),
    }));
  });

  it('throws InsufficientCreditsError on partial grant (settles partial back to 0)', async () => {
    grantLeaseMock.mockResolvedValueOnce({
      leaseId: 'lease_partial', amountGranted: 0.01, expiresAt: NOW,
    });
    settleLeaseMock.mockResolvedValueOnce({ refundedUsd: 0.01 });
    await expect(reserveActorCredits(POOL, {
      userId: 'u', region: 'us-east-1',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0,
      transcript: false,
      markupPct: 0,
    })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(settleLeaseMock).toHaveBeenCalledWith(POOL, { leaseId: 'lease_partial', actualUsd: 0 });
  });

  it('throws InsufficientCreditsError when grantLease returns no lease', async () => {
    grantLeaseMock.mockResolvedValueOnce({ leaseId: null, amountGranted: 0, expiresAt: NOW });
    await expect(reserveActorCredits(POOL, {
      userId: 'u', region: 'us-east-1',
      recordingUsdPerSecond: 0.0001388,
      transcriptionUsdPerSecond: 0,
      transcript: false,
      markupPct: 0,
    })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });
});

describe('settleActorCall', () => {
  it('charges actualSeconds * usdPerSecond * (1+markup)', async () => {
    settleLeaseMock.mockResolvedValueOnce({ refundedUsd: 0.04 });
    const out = await settleActorCall(POOL, {
      leaseId: 'lease_1',
      actualSeconds: 60,
      usdPerSecond: 0.0001388,
      markupPct: 30,
    });
    expect(settleLeaseMock).toHaveBeenCalledWith(POOL, expect.objectContaining({
      leaseId: 'lease_1',
      actualUsd: expect.closeTo(0.0108264, 5),
    }));
    expect(out.refundedUsd).toBe(0.04);
  });
});
