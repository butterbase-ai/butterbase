// submodules/butterbase-oss/packages/cli/src/lib/repo-api.ts
import { apiGet, apiPost, apiDelete } from './api-client.js';

export interface FileEntry { path: string; sha256: string; size: number; mode?: number }
export interface PrepareResponse {
  snapshot_id: string;
  total_bytes: number;
  file_count: number;
  missing_blobs: { sha256: string; uploadUrl: string }[];
}
export interface CommitResponse {
  snapshot_id: string;
  total_bytes: number;
  file_count: number;
}
export interface Manifest { files: FileEntry[]; message?: string }
export interface SnapshotResponse { snapshot_id: string; manifest: Manifest }
export interface SnapshotListItem { snapshot_id: string; created_at: string }
export interface BlobUrlResponse { sha256: string; size: number; downloadUrl: string; expiresIn: number }

export interface CloneJob {
  job_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  source_app_id: string;
  dest_app_id: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export const repoApi = {
  prepare(appId: string, body: { files: FileEntry[]; message?: string }) {
    return apiPost<PrepareResponse>(`/v1/${appId}/repo/snapshots/prepare`, body);
  },
  commit(appId: string, manifest: { files: FileEntry[]; message?: string }) {
    return apiPost<CommitResponse>(`/v1/${appId}/repo/snapshots/commit`, { manifest });
  },
  getLatest(appId: string) {
    return apiGet<SnapshotResponse>(`/v1/${appId}/repo/snapshots/latest`);
  },
  getSnapshot(appId: string, snapshotId: string) {
    return apiGet<SnapshotResponse>(`/v1/${appId}/repo/snapshots/${snapshotId}`);
  },
  listSnapshots(appId: string) {
    return apiGet<{ snapshots: SnapshotListItem[] }>(`/v1/${appId}/repo/snapshots`);
  },
  getBlobUrl(appId: string, sha256: string) {
    return apiGet<BlobUrlResponse>(`/v1/${appId}/repo/blobs/${sha256}`);
  },
  batchBlobUrls(appId: string, shas: string[]) {
    return apiPost<{ blobs: { sha256: string; size: number; downloadUrl: string; expiresIn: number }[] }>(`/v1/${appId}/repo/blobs/batch`, { shas });
  },
  wipe(appId: string) {
    return apiDelete<{ message: string; app_id: string }>(`/v1/${appId}/repo`);
  },
};

export const cloneApi = {
  create(sourceAppId: string, body: { name?: string; region?: string }) {
    return apiPost<{ job_id: string; status: string }>(`/v1/templates/${sourceAppId}/clone`, body);
  },
  get(jobId: string) {
    return apiGet<CloneJob>(`/v1/clone-jobs/${jobId}`);
  },
  retry(jobId: string) {
    return apiPost<{ job_id: string; status: string }>(`/v1/clone-jobs/${jobId}/retry`, {});
  },
};

/** Raw PUT to a presigned S3 URL. No auth header — URL is signed. */
export async function uploadBlob(presignedUrl: string, body: Buffer): Promise<void> {
  const res = await fetch(presignedUrl, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'content-type': 'application/octet-stream' },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Presigned PUT failed (${res.status}): ${txt.slice(0, 300)}`);
  }
}

/** Fetch a blob via the presigned GET URL returned by getBlobUrl. */
export async function downloadBlob(presignedUrl: string): Promise<Buffer> {
  const res = await fetch(presignedUrl);
  if (!res.ok) throw new Error(`Presigned GET failed (${res.status})`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
