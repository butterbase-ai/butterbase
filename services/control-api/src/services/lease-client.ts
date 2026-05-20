export interface LeaseGrantRequest {
  userId: string;
  amountUsd: number;
  platformControlApiUrl: string;
  fetch?: typeof fetch;
}

export interface LeaseGrantResponse {
  leaseId: string | null;
  amountGranted: number;
  expiresAt: Date;
}

export async function requestLeaseFromPlatform(req: LeaseGrantRequest): Promise<LeaseGrantResponse> {
  const fetcher = req.fetch ?? fetch;
  const region = process.env.BUTTERBASE_REGION;
  if (!region) throw new Error('BUTTERBASE_REGION required for lease-client');
  const secret = process.env.BUTTERBASE_INTERNAL_SECRET;
  if (!secret) throw new Error('BUTTERBASE_INTERNAL_SECRET required for lease-client');

  const url = `${req.platformControlApiUrl}/v1/internal/lease/grant`;
  const res = await fetcher(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-butterbase-internal-secret': secret,
    },
    body: JSON.stringify({ userId: req.userId, region, amountUsd: req.amountUsd }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`lease grant failed: ${res.status} ${text}`);
  }
  const body = await res.json() as { leaseId: string | null; amountGranted: number; expiresAt: string };
  return {
    leaseId: body.leaseId,
    amountGranted: body.amountGranted,
    expiresAt: new Date(body.expiresAt),
  };
}

export interface LeaseSettleRequest {
  leaseId: string;
  actualUsd: number;
  platformControlApiUrl: string;
  fetch?: typeof fetch;
}

export interface LeaseSettleResponse {
  refundedUsd: number;
}

export async function settleLeaseFromPlatform(req: LeaseSettleRequest): Promise<LeaseSettleResponse> {
  const fetcher = req.fetch ?? fetch;
  const secret = process.env.BUTTERBASE_INTERNAL_SECRET;
  if (!secret) throw new Error('BUTTERBASE_INTERNAL_SECRET required for lease-client');

  const url = `${req.platformControlApiUrl}/v1/internal/lease/${encodeURIComponent(req.leaseId)}/settle`;
  const res = await fetcher(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-butterbase-internal-secret': secret,
    },
    body: JSON.stringify({ actualUsd: req.actualUsd }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`lease settle failed: ${res.status} ${text}`);
  }
  return await res.json() as LeaseSettleResponse;
}
