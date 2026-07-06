import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiGet, apiPost, apiPatch, apiDelete } from '../api-client.js';

export function registerManageStorage(server: McpServer) {
  server.tool(
    'manage_storage',
    `Manage app storage: presigned upload/download URLs, list/delete objects, update config.

Actions:
  - "upload_url":    Get a presigned PUT URL to upload a file (expires in 15 min)
  - "download_url":  Get a presigned GET URL for a stored file (expires in 1 hour)
  - "list":          List all objects in app storage with metadata
  - "delete":        Permanently delete an object from S3 + database
  - "update_config": Update storage config (publicReadEnabled, per-app storage cap, per-file size cap)

Parameters by action:
  upload_url:    { app_id, action: "upload_url", filename, content_type, size_bytes, public? }
  download_url:  { app_id, action: "download_url", object_id }
  list:          { app_id, action: "list" }
  delete:        { app_id, action: "delete", object_id }
  update_config: { app_id, action: "update_config", publicReadEnabled?, storageLimitBytes?, maxFileSizeMb? }

object_id is the UUID returned from upload or list. Do NOT pass the s3_key / bucket path
(e.g. app_id/user_id/uuid_file.jpg) — that is metadata only and is not a usable URL.

Upload workflow:
  1. action: "upload_url"  → returns { upload_url, object_id, expires_at }
  2. PUT the file to upload_url with the matching Content-Type header
  3. Persist object_id (e.g. users.avatar_id)
  4. Later: action: "download_url" with that object_id

Set public: true on upload_url to make the file downloadable by any authenticated user
(e.g. post images, avatars). Files are private by default.

publicReadEnabled (update_config):
  - true:  any authenticated user can download any file (uploads/deletes still user-scoped)
  - false (default): users can only download their own files; platform auth (API key) can still access any file

storageLimitBytes (update_config):
  - Per-app total storage cap in bytes. Defaults to 1 GB (1073741824) when unset.
  - Must be a positive integer and cannot exceed the org's plan cap
    (rejected with VALIDATION_INVALID_SCHEMA if it does). To raise it above the
    plan cap, upgrade the plan via manage_billing.

maxFileSizeMb (update_config):
  - Per-file size cap in megabytes. Defaults to 10 MB when unset.
  - Raise this to accept larger uploads (e.g. video/audio). Must be a positive integer.

At least one of publicReadEnabled, storageLimitBytes, or maxFileSizeMb must be supplied.

Limits & errors:
  - Files: default max 10 MB each; raise via maxFileSizeMb (QUOTA_FILE_SIZE_EXCEEDED)
  - QUOTA_STORAGE_EXCEEDED: delete unused files or upgrade plan
  - RESOURCE_NOT_FOUND: app or object doesn't exist (verify object_id, not s3_key)
  - delete is idempotent (no-op if already deleted); upload/download URL generation is not (new URL each call)

Warning: "delete" cannot be undone. Update DB references (e.g. users.avatar_id) first.`,
    {
      app_id: z.string().describe('The app ID (e.g. app_abc123def456)'),
      action: z.enum(['upload_url', 'download_url', 'list', 'delete', 'update_config']).describe('The action to perform'),
      filename: z.string().optional().describe('Required for upload_url. The filename for the upload.'),
      content_type: z.string().optional().describe('Required for upload_url. MIME type (e.g. "image/png", "application/pdf").'),
      size_bytes: z.number().int().positive().optional().describe('Required for upload_url. File size in bytes.'),
      public: z.boolean().optional().describe('Optional for upload_url. Mark file as publicly downloadable. Default: false.'),
      object_id: z.string().optional().describe('Required for download_url and delete. Storage object UUID — not the s3_key path.'),
      publicReadEnabled: z.boolean().optional().describe('Optional for update_config. Enable/disable app-wide public read.'),
      storageLimitBytes: z.number().int().positive().optional().describe('Optional for update_config. Per-app total storage cap in bytes. Cannot exceed the plan cap.'),
      maxFileSizeMb: z.number().int().positive().optional().describe('Optional for update_config. Per-file size cap in megabytes. Default 10 MB.'),
    },
    {
      title: 'Manage Storage',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (args) => {
      const { app_id, action } = args;
      const need = (cond: unknown, msg: string) =>
        cond
          ? null
          : { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const };

      switch (action) {
        case 'upload_url': {
          const err =
            need(args.filename, '"filename" is required for upload_url.') ??
            need(args.content_type, '"content_type" is required for upload_url.') ??
            need(args.size_bytes, '"size_bytes" is required for upload_url.');
          if (err) return err;
          const result = await apiPost(`/storage/${app_id}/upload`, {
            filename: args.filename,
            contentType: args.content_type,
            sizeBytes: args.size_bytes,
            public: args.public ?? false,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'download_url': {
          const err = need(args.object_id, '"object_id" is required for download_url.');
          if (err) return err;
          const result = await apiGet(`/storage/${app_id}/download/${args.object_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'list': {
          const result = await apiGet(`/storage/${app_id}/objects`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'delete': {
          const err = need(args.object_id, '"object_id" is required for delete.');
          if (err) return err;
          const result = await apiDelete(`/storage/${app_id}/${args.object_id}`);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
        case 'update_config': {
          const err = need(
            args.publicReadEnabled !== undefined ||
              args.storageLimitBytes !== undefined ||
              args.maxFileSizeMb !== undefined,
            '"publicReadEnabled", "storageLimitBytes", or "maxFileSizeMb" is required for update_config.',
          );
          if (err) return err;
          const body: Record<string, unknown> = {};
          if (args.publicReadEnabled !== undefined) body.publicReadEnabled = args.publicReadEnabled;
          if (args.storageLimitBytes !== undefined) body.storageLimitBytes = args.storageLimitBytes;
          if (args.maxFileSizeMb !== undefined) body.maxFileSizeMb = args.maxFileSizeMb;
          const result = await apiPatch(`/v1/${app_id}/config/storage`, body);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        }
      }
    }
  );
}
