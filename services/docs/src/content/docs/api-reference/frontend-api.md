---
title: Frontend API
description: Complete reference for frontend deployment endpoints.
sidebar:
  order: 5
---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/frontend/deployments | Create a deployment |
| POST | /v1/\{app_id}/frontend/deployments/\{id}/start | Start a deployment |
| GET | /v1/\{app_id}/frontend/deployments | List deployment history |
| GET | /v1/\{app_id}/frontend/deployments/\{id} | Get deployment details |
| POST | /v1/\{app_id}/frontend/deployments/\{id}/sync | Force-sync status |
| POST | /v1/\{app_id}/frontend/deployments/\{id}/cancel | Cancel deployment |
| DELETE | /v1/\{app_id}/frontend/deployments/\{id} | Delete a deployment |
| PUT | /v1/\{app_id}/frontend/env | Set environment variables |
| GET | /v1/\{app_id}/frontend/env | List environment variable keys |

## Create deployment

```json
POST /v1/{app_id}/frontend/deployments
Authorization: Bearer {token}

{
  "framework": "react-vite"
}
```

**Response:**

```json
{
  "id": "deployment-uuid",
  "uploadUrl": "https://...",
  "expiresIn": 900,
  "maxSizeBytes": 104857600
}
```

### Framework values

| Framework | Value |
|-----------|-------|
| React (Vite) | `react-vite` |
| Next.js (static) | `nextjs-static` |
| Static HTML | `static` |
| Other | `other` |

## Upload and start

**Upload zip:**

```bash
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/zip" \
  --data-binary @frontend.zip
```

**Start deployment:**

```
POST /v1/{app_id}/frontend/deployments/{id}/start
```

## Deployment statuses

| Status | Meaning |
|--------|---------|
| `WAITING` | Created, awaiting upload |
| `UPLOADING` | Processing |
| `BUILDING` | Building |
| `READY` | Succeeded |
| `ERROR` | Failed |
| `CANCELED` | Canceled |

## Environment variables

```json
PUT /v1/{app_id}/frontend/env

{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "NEXT_PUBLIC_API_KEY": "pk_test_123"
}
```

Values are encrypted at rest. Only keys are returned when listing.

## Limits

| Limit | Value |
|-------|-------|
| Max size | 100 MB (compressed) |
| Upload expiration | 15 minutes |
| Free plan | 1 active deployment |
| Pro plan | Unlimited |

## Custom Domains

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/custom-domains | Add a custom domain |
| GET | /v1/\{app_id}/custom-domains | List custom domains |
| GET | /v1/\{app_id}/custom-domains/\{id}/status | Check verification status |
| POST | /v1/\{app_id}/custom-domains/\{id}/verify | Re-trigger verification |
| DELETE | /v1/\{app_id}/custom-domains/\{id} | Remove a custom domain |

### Add custom domain

```json
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{
  "hostname": "app.example.com"
}
```

**Response:**

```json
{
  "domain": {
    "id": "uuid",
    "hostname": "app.example.com",
    "status": "pending",
    "ssl_status": "pending"
  },
  "cname_target": "butterbase.dev",
  "instructions": "Add a CNAME record..."
}
```

The response `instructions` field contains the exact CNAME setup steps for your DNS provider. If your DNS is managed by Cloudflare, the record **must be set to DNS-only (grey cloud)**. Proxied (orange cloud) CNAMEs between different Cloudflare accounts produce Error 1014 and will not work.

### Check status

```
GET /v1/{app_id}/custom-domains/{id}/status
```

Returns current verification and SSL status from Cloudflare. Poll this endpoint after adding a domain (typically resolves within 5–15 minutes).

### Errors

| Error | Meaning |
|-------|---------|
| `feature_not_available` | Plan doesn't include custom domains (upgrade to Pro) |
| `RESOURCE_ALREADY_EXISTS` | Hostname is already registered |
| `RESOURCE_NOT_FOUND` | Domain ID not found |
