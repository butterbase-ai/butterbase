---
title: AI Integration
description: Call large language models through an OpenAI-compatible API with usage tracking.
---

Butterbase includes a built-in AI model gateway that lets your app call large language models through an OpenAI-compatible API.

## Two ways to call the gateway

- **App-scoped** (`/v1/{app_id}/...`) — tied to an app you've created in Butterbase. Use this when AI calls happen on behalf of an app and you want them logged against it. The app's AI configuration (default model, allowed models) applies.
- **App-less** (`/v1/...`) — for using Butterbase as a generic model gateway. Authenticate with a platform JWT or a personal API key that has the `ai:gateway` scope. Useful for scripts, CLIs, the OpenAI SDK, or any client that doesn't need an app on the platform.

The request and response shapes are identical between the two — only the path differs. See the [AI API reference](/api-reference/ai-api/) for the gateway endpoints, error contract, and how to mint a personal API key.

## How it works

Your app sends chat completion or embedding requests to Butterbase. Usage cost is tracked automatically and counted against your plan's AI credits allowance.

## Chat completions

```json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is Butterbase?" }
  ],
  "max_tokens": 500,
  "temperature": 0.7
}
```

**Streaming:** Set `"stream": true` to receive server-sent events.

## Multimodal content

Message `content` can be a plain string or an array of typed content parts. Mix text, images, and video in a single message.

### Images

Pass a publicly accessible URL (or a `data:` URI for base64-encoded images):

```json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "https://example.com/photo.jpg" } }
      ]
    }
  ]
}
```

The optional `detail` field controls resolution when the model supports it (`"low"`, `"high"`, or `"auto"`):

```json
{ "type": "image_url", "image_url": { "url": "https://example.com/diagram.png", "detail": "high" } }
```

### Video

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Summarise this clip." },
    { "type": "video_url", "video_url": { "url": "https://example.com/clip.mp4" } }
  ]
}
```

:::note
Multimodal support depends on the model. Vision models such as `anthropic/claude-sonnet-4.6`, `anthropic/claude-opus-4.6`, and `openai/gpt-4o` accept images. Not all models accept video. Passing unsupported content parts to a text-only model returns a provider error.
:::

### Multiple images

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Compare these two screenshots." },
    { "type": "image_url", "image_url": { "url": "https://example.com/before.png" } },
    { "type": "image_url", "image_url": { "url": "https://example.com/after.png" } }
  ]
}
```

### Using Butterbase Storage URLs

If your images are stored in Butterbase Storage, resolve a presigned download URL first:

```typescript
const { data } = await butterbase.storage.getDownloadUrl(objectId);

const response = await fetch(`${apiUrl}/v1/${appId}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'anthropic/claude-sonnet-4.6',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: data.url } },
      ],
    }],
  }),
});
```

## Embeddings

Generate vector embeddings for semantic search, clustering, and other ML tasks:

```json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
```

**Batch input:** Pass an array of strings:

```json
{
  "model": "openai/text-embedding-3-small",
  "input": ["first text", "second text", "third text"]
}
```

### Available embedding models

| Model | ID | Dimensions |
|-------|-----|------------|
| Text Embedding 3 Small | `openai/text-embedding-3-small` | 1536 |
| Text Embedding 3 Large | `openai/text-embedding-3-large` | 3072 |
| Text Embedding Ada 002 | `openai/text-embedding-ada-002` | 1536 |

## Video generation

Video models work differently from chat: generation is **asynchronous** and can take 30 seconds to several minutes. You submit a job, poll until it's ready, and then download the rendered MP4. See [Video generation](/api-reference/ai-api/#video-generation) in the API reference for the full flow.

Video is billed per call (not per token) — the actual cost appears as `charged_credits_usd` in the job's final poll response.

## Available models

Butterbase supports a wide range of frontier and open-source models, including:

| Model | ID |
|-------|-----|
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` |
| Claude Opus 4.6 | `anthropic/claude-opus-4.6` |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` |
| Claude 3.7 Sonnet | `anthropic/claude-3.7-sonnet` |
| Claude 3.7 Sonnet (thinking) | `anthropic/claude-3.7-sonnet:thinking` |
| GPT-4o | `openai/gpt-4o` |
| GPT-4o Mini | `openai/gpt-4o-mini` |
| Llama 3.3 70B | `meta-llama/llama-3.3-70b-instruct` |
| DeepSeek R1 | `deepseek/deepseek-r1` |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` |

Browse the complete catalog (with current pricing) on the **AI models** page in the dashboard, or fetch it programmatically — no auth required — via [`GET /v1/public/models`](/api-reference/ai-api/#public-model-catalog).

## AI configuration

Configure AI settings per app:

```json
PUT /v1/{app_id}/ai/config

{
  "defaultModel": "anthropic/claude-sonnet-4.6",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-sonnet-4.6", "anthropic/claude-haiku-4.5"]
}
```

| Setting | Description |
|---------|-------------|
| `defaultModel` | Model used when none is specified |
| `maxTokensPerRequest` | Maximum tokens per request (1–100,000) |
| `allowedModels` | Restrict which models can be used |

## Usage tracking

```
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
```

Returns total tokens, cost, and breakdown by model.

## Using AI in serverless functions

The runtime auto-injects `BUTTERBASE_APP_ID` and `BUTTERBASE_API_URL` — you only need to supply your API key via `envVars`:

```typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { BUTTERBASE_APP_ID, BUTTERBASE_API_URL, BUTTERBASE_API_KEY } = ctx.env;

  const aiResponse = await fetch(`${BUTTERBASE_API_URL}/v1/${BUTTERBASE_APP_ID}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${BUTTERBASE_API_KEY}`
    },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Summarize this text: ...' }],
      max_tokens: 200
    })
  });

  const result = await aiResponse.json();
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

## AI credits

AI usage (chat completions and embeddings) is billed against your unified credit balance. See [Billing & Plans](/core-concepts/billing/) for current plan allowances, topups, and how credits are consumed.
