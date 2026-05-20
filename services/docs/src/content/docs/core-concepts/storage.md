---
title: File Storage
description: Upload and download files through presigned URLs with per-app and per-user isolation.
---

Butterbase provides file storage with presigned URLs. Files are organized per-app and per-user. Your frontend uploads and downloads files directly — file data never flows through your backend code.

Storage is co-located with your app's [region](/core-concepts/regions/), so uploads and downloads stay close to your users.

## How it works

1. **Request an upload URL** — Your app asks Butterbase for a presigned upload URL, providing the filename, content type, and size.
2. **Upload directly** — Your frontend uses the presigned URL to upload the file directly to storage.
3. **Reference the file** — Store the returned `objectId` in your database (e.g., as an `image_url` column).
4. **Download when needed** — Request a presigned download URL using the object ID.

## Object ID, object key, and URLs

| Value | What it is | What to do with it |
|--------|------------|---------------------|
| **`objectId`** | A stable UUID for this file | **Persist this** in your database. Use it for downloads and deletes. |
| **`objectKey`** | The path inside the bucket | **Not a URL.** Metadata only; do not store for display. |
| **`uploadUrl` / `downloadUrl`** | Temporary presigned HTTPS URLs | Use only for **immediate** operations. They **expire**. |

:::caution
Butterbase does not provide permanent public URLs for private files. Always mint a fresh presigned download URL when you need to show or fetch a file.
:::

## Common mistakes

- **Saving `objectKey` as a URL** — It's a path, not a URL. The UI will show broken images.
- **Using `objectKey` as `img src`** — Use `objectId` with the download endpoint to get a `downloadUrl`.
- **Storing only a presigned URL** — Presigned URLs expire. Store `objectId` as the source of truth.

## Uploading a file

**Step 1:** Request the upload URL.

```json
POST /storage/{app_id}/upload
Authorization: Bearer {token}

{
  "filename": "profile.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 102400,
  "public": false
}
```

Set `public: true` to mark the file as downloadable by any authenticated user. See [Public files](#public-files).

**Response:**

```json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
```

**Step 2:** Upload the file using the presigned URL.

```javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
```

**Step 3:** Save the `objectId` in your database.

## Downloading a file

```json
GET /storage/{app_id}/download/{object_id}
Authorization: Bearer {token}
```

**Response:**

```json
{
  "downloadUrl": "https://storage.example.com/...",
  "filename": "profile.jpg",
  "expiresIn": 3600
}
```

## Showing images in the UI

After loading rows that reference stored files by `objectId`:

1. For each file, call the download API or SDK `getDownloadUrl(objectId)`.
2. Use the returned `downloadUrl` as `<img src>` or download link.
3. For lists, resolve download URLs **in parallel** (`Promise.all`) for speed.

## Listing files

```
GET /storage/{app_id}/objects
Authorization: Bearer {token}
```

Returns an array of objects with `id`, `filename`, `content_type`, `size_bytes`, and `created_at`.

## Storage limits

| Limit | Default |
|-------|---------|
| Max file size | 10 MB per file |
| Total storage | 1 GB per app |
| Allowed content types | All types (configurable) |

## Access control

- **Service key:** Full access to all files. Uploads have no user association.
- **End-users:** Can only see and manage their own files. Uploads are automatically associated with the authenticated user.

## Public files

By default every uploaded file is private — only its uploader (or callers with a service key) can mint a download URL. There are two ways to make files publicly downloadable.

### Per-object: `public: true` at upload time

Set `public: true` in the upload request to mark a single file as publicly downloadable:

```json
{
  "filename": "post-image.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 204800,
  "public": true
}
```

Any authenticated end-user can then call `GET /storage/{app_id}/download/{object_id}` regardless of who uploaded it.

### App-wide: `publicReadEnabled`

Flip the app-level switch to make **all** files in the app readable by any authenticated user:

```json
PATCH /v1/{app_id}/config/storage
Authorization: Bearer {token}

{ "publicReadEnabled": true }
```

When enabled:
- Any authenticated user can download any file in the app.
- Uploads and deletes remain user-scoped — users can still only manage their own files.
- The per-object `public` flag becomes redundant.

### Authorization summary

A download URL is issued if **any** of the following is true:

1. The caller authenticated with a service key (`bb_sk_...`).
2. The app has `publicReadEnabled: true`.
3. The object has `public: true`.
4. The authenticated user owns the object.

## URL expiration

- Upload URLs expire after **5 minutes**
- Download URLs expire after **1 hour**

## SDK usage

```typescript
const { data } = await butterbase.storage.upload(file);
const { data: url } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);

// Mark a file as publicly downloadable
await butterbase.storage.upload(file, 'avatar.png', { public: true });
```
