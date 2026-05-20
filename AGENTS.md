# Agent notes (Butterbase)

## File storage

When implementing uploads or media in apps on Butterbase:

1. After upload, persist **`objectId`** (UUID) from the API/SDK response—not the **`objectKey`** (bucket path). The key is not a URL and will not work as `img src` or `href`.
2. To show images or offer downloads, call **`getDownloadUrl(objectId)`** (SDK) or **`GET /storage/{app_id}/download/{object_id}`** / MCP **`generate_download_url`** and use the returned **presigned URL** until it expires.
3. Resolve download URLs **when loading UI** (or API responses), not once at insert time only—presigned URLs expire; **`objectId`** is the stable reference.
4. For lists with many files, resolve presigned URLs **in parallel** (e.g. `Promise.all`).
5. Deployment issues (wrong host on presigned URLs, browser CORS on PUT): see **[DEPLOYMENT_PLAN.md](DEPLOYMENT_PLAN.md)** §2.5 Cloudflare R2 (`S3_PUBLIC_ENDPOINT`, R2 CORS).

Full product documentation: MCP **`butterbase_docs`** with topic **`storage`**, source [`services/mcp-server/src/docs/user-documentation.ts`](services/mcp-server/src/docs/user-documentation.ts) (`SECTIONS.storage`).
