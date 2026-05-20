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
