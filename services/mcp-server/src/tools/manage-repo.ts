// submodules/butterbase-oss/services/mcp-server/src/tools/manage-repo.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'crypto';
import { apiGet, apiPost, apiDelete } from '../api-client.js';

interface FileEntry { path: string; sha256: string; size: number }
interface Manifest { v?: 1; files: FileEntry[]; message?: string }

export function registerManageRepo(server: McpServer) {
  server.tool(
    'manage_repo',
    `Manage an app's repo (content-addressed code snapshots).

Actions:
  - "push":             Push a small set of files (≤1 MB total over MCP — for larger repos shell out to \`butterbase repo push\`). Files are { path, content_base64 } pairs. Server computes sha and runs prepare → upload → commit.
  - "pull_latest":      Fetch the latest snapshot's manifest (does not write files locally). Returns { snapshot_id, files: [{ path, sha256, size, downloadUrl }] } — agents fetch each downloadUrl directly.
  - "status":           Returns { app_id, pinned_snapshot_id?, remote_latest_snapshot_id?, file_count }. No working-tree comparison (the server has no working tree).
  - "list_snapshots":   List snapshot history newest-first.
  - "wipe":             Delete every snapshot and blob, then null repo_latest_snapshot. Irreversible.

Parameters by action:
  push:           { action: "push", app_id, files: [{ path, content_base64 }], message? }
  pull_latest:    { action: "pull_latest", app_id }
  status:         { action: "status", app_id }
  list_snapshots: { action: "list_snapshots", app_id }
  wipe:           { action: "wipe", app_id }

Auth matrix: writes (push, wipe) require app owner. Reads (pull_latest, status, list_snapshots) work for owner or anonymously on a public app; private+non-owner gets 404.`,
    {
      action: z.enum(['push', 'pull_latest', 'status', 'list_snapshots', 'wipe']),
      app_id: z.string().describe('App ID — required for every action.'),
      files: z.array(z.object({
        path: z.string().describe('Relative path inside the repo (no .., no leading /).'),
        content_base64: z.string().describe('File bytes base64-encoded. Server decodes, hashes, and uploads.'),
      })).optional().describe('Required for "push".'),
      message: z.string().optional().describe('Optional snapshot message for "push".'),
    },
    {
      title: 'Manage Repo',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args) => {
      const text = (x: unknown) => ({ content: [{ type: 'text' as const, text: typeof x === 'string' ? x : JSON.stringify(x, null, 2) }] });
      const errOut = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const });

      switch (args.action) {
        case 'pull_latest': {
          const latest = await apiGet<{ snapshot_id: string; manifest: Manifest }>(`/v1/${args.app_id}/repo/snapshots/latest`);
          const shas = latest.manifest.files.map(f => f.sha256);
          // De-dup shas — content-addressed storage means multiple paths can share the same sha.
          const uniqueShas = Array.from(new Set(shas));
          // Batch endpoint caps at 1000 shas per call; chunk if needed.
          const urlBySha = new Map<string, string>();
          for (let i = 0; i < uniqueShas.length; i += 1000) {
            const chunk = uniqueShas.slice(i, i + 1000);
            const res = await apiPost<{ blobs: { sha256: string; size: number; downloadUrl: string }[] }>(`/v1/${args.app_id}/repo/blobs/batch`, { shas: chunk });
            for (const b of res.blobs) urlBySha.set(b.sha256, b.downloadUrl);
          }
          const files = latest.manifest.files.map(f => ({
            path: f.path,
            sha256: f.sha256,
            size: f.size,
            downloadUrl: urlBySha.get(f.sha256) ?? null,
          }));
          return text({ snapshot_id: latest.snapshot_id, files });
        }
        case 'list_snapshots': {
          const res = await apiGet(`/v1/${args.app_id}/repo/snapshots`);
          return text(res);
        }
        case 'status': {
          // No "working tree" on the server; return what we can. Use the list
          // endpoint (200 + empty array when no snapshots) rather than
          // /latest (404 when no snapshots) so we can distinguish
          //   "app has no snapshots yet"  (empty list, safe to report)
          //   from
          //   "you cannot see this app"   (401/403/404 from auth) — must surface
          // The previous try/catch on /latest swallowed the auth 404 and
          // returned {remote_latest_snapshot_id: null, file_count: 0}, making
          // access-denied indistinguishable from an empty repo.
          const list = await apiGet<{ snapshots: { snapshot_id: string; created_at: string }[] }>(
            `/v1/${args.app_id}/repo/snapshots`
          );
          if (list.snapshots.length === 0) {
            return text({ app_id: args.app_id, remote_latest_snapshot_id: null, file_count: 0 });
          }
          const latest = await apiGet<{ snapshot_id: string; manifest: Manifest }>(
            `/v1/${args.app_id}/repo/snapshots/latest`
          );
          return text({
            app_id: args.app_id,
            remote_latest_snapshot_id: latest.snapshot_id,
            file_count: latest.manifest.files.length,
          });
        }
        case 'wipe': {
          const res = await apiDelete(`/v1/${args.app_id}/repo`);
          return text(res);
        }
        case 'push': {
          if (!args.files || args.files.length === 0) return errOut('"files" is required for push.');
          // Hard size check — 1 MB cap per spec; agents should shell out to the CLI above this.
          let total = 0;
          for (const f of args.files) total += Math.ceil((f.content_base64.length * 3) / 4);
          if (total > 1024 * 1024) return errOut(`push is capped at ~1 MB total over MCP (got ~${total} bytes). Use \`butterbase repo push\` for larger snapshots.`);

          const files: FileEntry[] = [];
          const blobsByPath = new Map<string, Buffer>();
          const seen = new Set<string>();
          for (const f of args.files) {
            if (seen.has(f.path)) return errOut(`duplicate path: ${f.path}`);
            seen.add(f.path);
            const buf = Buffer.from(f.content_base64, 'base64');
            const sha256 = createHash('sha256').update(buf).digest('hex');
            files.push({ path: f.path, sha256, size: buf.byteLength });
            blobsByPath.set(f.path, buf);
          }
          const body = args.message ? { files, message: args.message } : { files };
          const prep = await apiPost<{ snapshot_id: string; missing_blobs: { sha256: string; uploadUrl: string }[] }>(
            `/v1/${args.app_id}/repo/snapshots/prepare`, body
          );
          // Map sha → buf via any path that produced it.
          const bufBySha = new Map<string, Buffer>();
          for (const f of files) bufBySha.set(f.sha256, blobsByPath.get(f.path)!);

          for (const m of prep.missing_blobs) {
            const buf = bufBySha.get(m.sha256);
            if (!buf) return errOut(`server asked for blob ${m.sha256} not in our manifest`);
            const r = await fetch(m.uploadUrl, { method: 'PUT', body: buf as any, headers: { 'content-type': 'application/octet-stream' } });
            if (!r.ok) return errOut(`presigned PUT failed (${r.status}): ${await r.text().catch(() => '')}`);
          }
          const commitRes = await apiPost(`/v1/${args.app_id}/repo/snapshots/commit`, { manifest: body });
          return text(commitRes);
        }
      }
    }
  );
}
