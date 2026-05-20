---
title: Storage API
description: Complete reference for file storage endpoints.
sidebar:
  order: 3
---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /storage/\{app_id}/upload | Request a presigned upload URL |
| GET | /storage/\{app_id}/objects | List all files for the app |
| GET | /storage/\{app_id}/download/\{object_id} | Request a presigned download URL |
| DELETE | /storage/\{app_id}/\{object_id} | Delete a file |

## Upload

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

Set `public: true` to mark the uploaded file as downloadable by any authenticated user (not just the uploader). See [Public files](/core-concepts/storage#public-files).

**Response:**

```json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
```

Then upload the file:

```javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
```

## Download

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

## List files

```
GET /storage/{app_id}/objects
Authorization: Bearer {token}
```

Returns array of `{ id, filename, content_type, size_bytes, created_at }`.

## URL expiration

| URL type | Expiration |
|----------|-----------|
| Upload | 5 minutes |
| Download | 1 hour |

## Storage limits

| Limit | Default |
|-------|---------|
| Max file size | 10 MB |
| Total storage | 1 GB per app |
| Content types | All (configurable) |

## Access control

| Auth | Access |
|------|--------|
| Service key | All files, no user association |
| End-user JWT | Own files only, auto-associated |

## App-wide storage configuration

| Method | Path | Purpose |
|--------|------|---------|
| PATCH | /v1/\{app_id}/config/storage | Toggle app-wide public read access |

```json
PATCH /v1/{app_id}/config/storage
Authorization: Bearer {token}

{ "publicReadEnabled": true }
```

**Response:**

```json
{
  "message": "Storage configuration updated successfully",
  "app_id": "app_abc123",
  "storage_config": {
    "maxFileSizeMb": 10,
    "allowedContentTypes": ["*/*"],
    "publicReadEnabled": true
  }
}
```

When `publicReadEnabled` is `true`, any authenticated user can download any file in the app. Uploads and deletes remain user-scoped.
