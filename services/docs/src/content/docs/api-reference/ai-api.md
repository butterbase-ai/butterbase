---
title: AI API
description: Complete reference for the AI model gateway endpoints.
sidebar:
  order: 6
---

Butterbase exposes an OpenAI-compatible API for chat completions, embeddings, and model listing. There are two ways to call it:

- **App-scoped** — calls go through `/v1/{app_id}/...`, are billed to the app's owner, and inherit the app's AI configuration (default model, allowed models).
- **Gateway mode** — calls go through `/v1/...` (no `app_id`), authenticated with a platform JWT or a personal API key. Use this when you want a generic OpenAI-compatible gateway and don't need an app.

## App-scoped endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/chat/completions | Chat completion (OpenAI-compatible) |
| POST | /v1/\{app_id}/embeddings | Generate embeddings |
| GET | /v1/\{app_id}/ai/config | Get AI configuration |
| PUT | /v1/\{app_id}/ai/config | Update AI configuration |
| GET | /v1/\{app_id}/ai/usage | Get AI usage statistics |

## Gateway endpoints (no app required)

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | /v1/chat/completions | Chat completion | Required |
| POST | /v1/embeddings | Generate embeddings | Required |
| GET | /v1/models | List available models (OpenAI-shape) | Required |
| GET | /v1/public/models | Public model catalog with pricing | None |

Drop-in compatible with the OpenAI SDK: point `baseURL` at `https://api.butterbase.ai/v1` and use a personal API key as the bearer token. The request and response shapes are identical to the app-scoped variants — only the path differs.

### Chat completions (gateway)

```json
POST /v1/chat/completions
Authorization: Bearer bb_sk_...

{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "max_tokens": 500,
  "temperature": 0.7,
  "stream": false
}
```

Set `"stream": true` for server-sent events.

### Embeddings (gateway)

```json
POST /v1/embeddings
Authorization: Bearer bb_sk_...

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
```

### List models

```json
GET /v1/models
Authorization: Bearer bb_sk_...
```

Response:

```json
{
  "object": "list",
  "data": [
    { "id": "anthropic/claude-3.5-sonnet", "object": "model", "display_name": "Claude 3.5 Sonnet" },
    { "id": "openai/gpt-4o", "object": "model", "display_name": "GPT-4o" }
  ]
}
```

### Public model catalog

A separate **unauthenticated** endpoint returns the full catalog with pricing and context window — useful for documentation pages, model pickers, and tooling that needs to enumerate models before the user has signed in.

```
GET /v1/public/models
```

No authorization header required.

Response:

```json
{
  "models": [
    {
      "id": "anthropic/claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "inputPricePerMTokens": 3.6,
      "outputPricePerMTokens": 18.0,
      "contextWindow": 200000
    },
    {
      "id": "openai/gpt-4o",
      "name": "GPT-4o",
      "inputPricePerMTokens": 3.0,
      "outputPricePerMTokens": 12.0,
      "contextWindow": 128000
    }
  ]
}
```

Prices are per 1 million tokens and reflect what your account is charged when you call the model. `contextWindow` may be `null` for models that don't report it.

### Authentication

Authenticate with either your platform JWT (for session-based clients like the dashboard) or a personal API key. Personal keys must have the `ai:gateway` scope to access these endpoints. See [Personal API keys](#personal-api-keys) below.

### Errors

Errors are returned in OpenAI-compatible shape:

```json
{ "error": { "message": "...", "type": "...", "code": "..." } }
```

| Status | `error.type` | `error.code` | When |
|---|---|---|---|
| 401 | `authentication_error` | `missing_credentials` | No `Authorization` header. |
| 401 | `authentication_error` | `invalid_api_key` | Token is unknown, revoked, or expired. |
| 403 | `permission_error` | `insufficient_scope` | API key is missing the `ai:gateway` scope. |
| 402 | `billing_error` | `insufficient_credits` | Account balance is too low for the requested call. |
| 404 | `invalid_request_error` | `model_not_found` | Requested model id isn't available. |
| 400 | `invalid_request_error` | `invalid_request` | Request body failed validation. |
| 5xx | `api_error` | (varies) | Temporary upstream issue. Retry with backoff. |

## Chat completions

```json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "max_tokens": 500,
  "temperature": 0.7,
  "stream": false
}
```

Standard OpenAI-compatible response format. Set `"stream": true` for server-sent events.

## Embeddings

```json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
```

| Parameter | Description |
|-----------|-------------|
| `model` | Embedding model ID (required) |
| `input` | String or array of strings (required) |
| `encoding_format` | `"float"` (default) or `"base64"` |

### Available embedding models

| Model | ID | Dimensions |
|-------|-----|------------|
| Text Embedding 3 Small | `openai/text-embedding-3-small` | 1536 |
| Text Embedding 3 Large | `openai/text-embedding-3-large` | 3072 |
| Text Embedding Ada 002 | `openai/text-embedding-ada-002` | 1536 |

## Video generation

Video generation is **asynchronous**. You submit a job, poll for status, then download the bytes when it's done. A single video typically takes 30 seconds to several minutes depending on model and length.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /v1/\{app_id}/videos/completions | Submit a generation job |
| GET | /v1/\{app_id}/videos/completions/\{job_id} | Poll job status (also downloads when terminal) |
| GET | /v1/\{app_id}/videos/completions/\{job_id}/content?index=N | Stream the rendered MP4 |

### Choosing a model

The video models in your gateway appear in `GET /v1/{app_id}/ai/models` alongside chat and embedding models. Look for the ones whose IDs begin with provider prefixes for video families (e.g. `bytedance/seedance-…`, `kwaivgi/kling-…`, `pixverse/…`, `google/veo-…`). If you POST a video model to `/chat/completions`, Butterbase returns `400 USE_VIDEO_ENDPOINT` with the correct URL in the message.

### 1. Submit a job

**curl:**

```bash
curl -X POST "https://api.butterbase.ai/v1/$APP_ID/videos/completions" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bytedance/seedance-2.0-fast",
    "prompt": "A golden retriever running through sunflowers at sunset, cinematic",
    "duration": 4,
    "resolution": "720p",
    "aspect_ratio": "16:9"
  }'
```

**TypeScript (fetch):**

```typescript
const res = await fetch(`${BUTTERBASE_API_URL}/v1/${APP_ID}/videos/completions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'bytedance/seedance-2.0-fast',
    prompt: 'A golden retriever running through sunflowers at sunset, cinematic',
    duration: 4,
    resolution: '720p',
    aspect_ratio: '16:9',
  }),
});
const job = await res.json();
// { job_id, status: 'pending', polling_url }
```

**Python (requests):**

```python
import os, requests
res = requests.post(
    f"{os.environ['BUTTERBASE_API_URL']}/v1/{APP_ID}/videos/completions",
    headers={"Authorization": f"Bearer {os.environ['BUTTERBASE_API_KEY']}"},
    json={
        "model": "bytedance/seedance-2.0-fast",
        "prompt": "A golden retriever running through sunflowers at sunset, cinematic",
        "duration": 4,
        "resolution": "720p",
        "aspect_ratio": "16:9",
    },
)
job = res.json()
# {"job_id": "...", "status": "pending", "polling_url": "..."}
```

**Response (202 Accepted):**

```json
{
  "job_id": "5cd4be3e-c65e-4524-97cf-4595a76e2096",
  "status": "pending",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-c65e-4524-97cf-4595a76e2096"
}
```

**Request fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `model` | yes | Video model ID (see "Choosing a model" above). |
| `prompt` | yes | Text description of the video to generate. |
| `duration` | no | Length in seconds. Model-specific (commonly 4, 6, 8). |
| `resolution` | no | e.g. `720p`, `1080p`. Model-specific. |
| `aspect_ratio` | no | e.g. `16:9`, `9:16`, `1:1`. Model-specific. |
| `generate_audio` | no | Boolean. Some models can render audio alongside video. |
| `seed` | no | Integer for deterministic generation (not all providers honor this). |
| `input_images` | no | Array of HTTPS image URLs for image-to-video / first-frame guidance. |

### 2. Poll for status

Poll the URL from `polling_url` every 30 seconds until `status` is terminal (`completed`, `failed`, `cancelled`, or `expired`).

**curl:**

```bash
curl "https://api.butterbase.ai/v1/$APP_ID/videos/completions/$JOB_ID" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

**TypeScript:**

```typescript
async function poll(jobUrl: string, apiKey: string) {
  while (true) {
    const res = await fetch(jobUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const job = await res.json();
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 30_000));
  }
}
```

**Python:**

```python
import time, requests
def poll(job_url, api_key):
    while True:
        job = requests.get(job_url, headers={"Authorization": f"Bearer {api_key}"}).json()
        if job["status"] in {"completed", "failed", "cancelled", "expired"}:
            return job
        time.sleep(30)
```

**Response (when `completed`):**

```json
{
  "job_id": "5cd4be3e-c65e-4524-97cf-4595a76e2096",
  "status": "completed",
  "model": "bytedance/seedance-2.0-fast",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-...",
  "content_urls": [
    "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-.../content?index=0"
  ],
  "error": null,
  "created_at": "2026-05-24T09:59:10.738Z",
  "charged_credits_usd": 0.72576,
  "settled_at": "2026-05-24T10:00:56.769Z"
}
```

- `content_urls` is an array because some models render multiple variants. Use `?index=N` to pick one.
- `charged_credits_usd` is populated once the job settles (first terminal poll). It's `null` while pending or in progress.
- For `status: "failed"`, `error` carries the upstream message.

### 3. Download the video

The URLs in `content_urls` are absolute and require the same `Bearer` API key. They stream `video/mp4` bytes.

**curl:**

```bash
curl -L "$CONTENT_URL" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  --output video.mp4
```

**TypeScript:**

```typescript
const mp4 = await fetch(job.content_urls[0], { headers: { Authorization: `Bearer ${apiKey}` } });
const buf = Buffer.from(await mp4.arrayBuffer());
fs.writeFileSync('video.mp4', buf);
```

**Python:**

```python
import requests
with requests.get(job["content_urls"][0],
                  headers={"Authorization": f"Bearer {api_key}"}, stream=True) as r:
    with open("video.mp4", "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)
```

### Error codes

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `USE_VIDEO_ENDPOINT` | You sent a video model to `/chat/completions`; use `/videos/completions` instead. |
| 400 | `INVALID_INDEX` | `?index=` was not a non-negative integer. |
| 402 | `INSUFFICIENT_CREDITS` | Not enough credits to reserve the job. Response includes `required_usd`, `available_usd`, and your auto-refill state. |
| 403 | `FORBIDDEN` | You're not the submitter of this job. |
| 404 | `MODEL_NOT_FOUND` | Unknown model ID. |
| 404 | `JOB_NOT_FOUND` | Unknown job ID, or the job belongs to a different app. |
| 409 | `JOB_NOT_COMPLETED` | You requested `/content` but the job hasn't reached `completed`. |
| 502 | `MODEL_UNAVAILABLE` | Upstream temporarily unavailable. Retry. |

### Jobs survive across polls

Each job is persisted. You can poll from any client / process — there's no in-memory state. Lost the `polling_url`? It's `https://api.butterbase.ai/v1/{app_id}/videos/completions/{job_id}`.

If you stop polling before the job completes, the credit reservation is automatically released after a few minutes and any upstream charge that occurred is on us. Just don't expect to retrieve the video later — re-submit.

## Configuration

```json
PUT /v1/{app_id}/ai/config

{
  "defaultModel": "anthropic/claude-3.5-sonnet",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-3.5-sonnet"]
}
```

| Field | Description |
|-------|-------------|
| `defaultModel` | Model used when none specified |
| `maxTokensPerRequest` | Token limit per request (1-100,000) |
| `allowedModels` | Restrict allowed models |

## Usage

```
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
```

**Response:**

```json
{
  "totalTokens": 150000,
  "totalCost": 0.45,
  "byModel": {
    "anthropic/claude-3.5-sonnet": {
      "tokens": 120000,
      "cost": 0.40,
      "requests": 25
    }
  }
}
```

## Personal API keys

To call the gateway endpoints from outside the dashboard (scripts, CLIs, the OpenAI SDK), mint a personal API key with the `ai:gateway` scope.

```json
POST /api-keys
Authorization: Bearer {jwt}

{
  "name": "my-cli",
  "scopes": ["ai:gateway"]
}
```

The response contains the plaintext key once — store it immediately. Subsequent requests show only the prefix.

### Scopes

| Scope | Grants |
|---|---|
| `*` | Full access to all Butterbase APIs the user can use. |
| `ai:gateway` | Access to `POST /v1/chat/completions`, `POST /v1/embeddings`, and `GET /v1/models`. Nothing else. |

The dashboard at `/api-keys` lists and revokes keys; for now, scoping a key to `ai:gateway` is done by calling `POST /api-keys` directly.
