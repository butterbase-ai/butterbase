# Image Generation — `/v1/:appId/images/completions`

Butterbase exposes a **unified image-generation endpoint** that fronts every image model the router supports (OpenAI GPT Image, Google Gemini image, ByteDance Seedream, Alibaba Wan 2.6/2.7, PrunaAI, etc.) through a single async contract.

The endpoint is **always async**: submit returns `202 Accepted` immediately with a `polling_url`. The client polls until `status` is terminal (`completed`, `failed`, `cancelled`, or `expired`), then reads the image bytes from a `/content` sub-resource.

> **Note.** The existing `/v1/:appId/chat/completions` path continues to accept image-model requests via the multimodal chat contract. `/images/completions` is **additive**: prefer it when you need image-native parameters (`size`, `aspect_ratio`, `n`, `mask`, etc.) that the chat contract can't express.

---

## 1. Submit — `POST /v1/:appId/images/completions`

**Auth.** Same as `/chat/completions`: owner API key, app-scoped key (`bb_sk_*`), or an end-user JWT minted by the app's auth. End-users can only see jobs they submitted themselves.

**Request body.**

| field             | type              | required | notes                                                                 |
| ----------------- | ----------------- | -------- | --------------------------------------------------------------------- |
| `model`           | string            | yes      | Canonical id, e.g. `openai/gpt-image-2`, `alibaba/wan-2.7-image-pro`. |
| `prompt`          | string            | yes      | Non-empty.                                                            |
| `size`            | string            | no       | e.g. `"1024x1024"`, `"1K"`, `"2K"`. Model-dependent.                  |
| `aspect_ratio`    | string            | no       | e.g. `"1:1"`, `"16:9"`. Model-dependent.                              |
| `n`               | int (1–10)        | no       | Multi-image; only GPT Image supports this among wired models.         |
| `seed`            | int               | no       | Reproducibility, when the model supports it.                          |
| `negative_prompt` | string            | no       | Wan / some Seedream variants only.                                    |
| `input_images`    | string[] (≤ 14)   | no       | URLs. Reference / edit source.                                        |
| `mask`            | string (URL)      | no       | GPT Image edit-mode mask. **Not** aliased into `input_images`.        |
| `provider`        | object            | no       | Per-model escape hatch, whitelisted by the adapter.                   |

**Alias preprocessing.** These top-level keys are automatically folded into `input_images`:
`image`, `image_url`, `image_uri`, `reference_image`, `input_image`, `starting_image`. Send any of them (string or string[]); the server normalizes to `input_images`.

**Per-model parameter whitelist.** Each model accepts a specific set of top-level and `provider.*` keys. Sending an unsupported key returns `400 UNSUPPORTED_PARAM` with the full supported list.

| model family                                | top-level                                              | provider.*                                                                                          |
| ------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| OpenAI GPT Image (`openai/gpt-image-*`)     | `size`, `n`, `input_images`, `mask`                    | `quality`, `background`, `output_format`, `input_fidelity`, `moderation`, `output_compression`      |
| Google Gemini image (`google/gemini-*-image`) | `aspect_ratio`, `size`, `input_images`               | *(none)*                                                                                            |
| ByteDance Seedream                          | `size`, `input_images`                                 | `optimize_prompt_options`, `output_format`                                                          |
| Alibaba Wan 2.7 image / image-pro           | `size`, `seed`, `input_images`                         | `bbox_list`, `color_palette`, `enable_sequential`, `thinking_mode`                                  |
| Alibaba Wan 2.6 t2i                         | `size`, `seed`, `negative_prompt`                      | `prompt_extend`                                                                                     |
| Alibaba Wan 2.6 image (i2i)                 | `size`, `seed`, `negative_prompt`, `input_images`      | `prompt_extend`                                                                                     |
| PrunaAI                                     | `size`, `aspect_ratio`, `seed`, `input_images`         | `width`, `height`, `extra_fields`, `disable_safety_checker`, `turbo`                                |
| OpenRouter (via `openrouter` slot)          | `seed`, `input_images`                                 | `response_format`                                                                                   |

**Response — always 202.**

```json
{
  "job_id": "img-01H…",
  "status": "pending",
  "polling_url": "https://api.butterbase.ai/v1/APP_ID/images/completions/img-01H…"
}
```

> Even when the underlying provider is synchronous (OpenRouter serves image bytes inline on submit), the response is still `202` with `status: "pending"`. The row is transitioned to terminal **before** the reply, so the very next `GET` returns `completed` with the `content_urls`. This keeps the client contract uniform across sync and async providers.

**Example.**

```bash
curl -X POST "https://api.butterbase.ai/v1/APP_ID/images/completions" \
  -H "Authorization: Bearer bb_sk_..." \
  -H "Content-Type: application/json" \
  -d '{
        "model": "openai/gpt-image-2",
        "prompt": "a red apple on a wooden table",
        "size": "1024x1024",
        "n": 1
      }'
```

**Error codes.**

| status | code                     | when                                                                    |
| ------ | ------------------------ | ----------------------------------------------------------------------- |
| 400    | `UNSUPPORTED_PARAM`      | A top-level or `provider.*` key is not in the model's whitelist.        |
| 400    | `WRONG_MODALITY`         | Model is not an image model (e.g. `openai/gpt-4o`).                     |
| 400    | *(zod issues)*           | Malformed body — see `details` array.                                   |
| 402    | `INSUFFICIENT_CREDITS`   | Includes `auto_refill_*`, `monthly_allowance_usd`, `credits_usd`.       |
| 404    | `MODEL_NOT_FOUND`        | Canonical id not in the catalog.                                        |
| 502    | `MODEL_UNAVAILABLE`      | All routers for this model failed / are in cooldown.                    |

---

## 2. Poll — `GET /v1/:appId/images/completions/:jobId`

Returns the current state. Poll ~every 1–3 s; typical completion is under 20 s for OpenRouter (sync-inline) and 5–60 s for ImaRouter (async).

Non-terminal:

```json
{
  "job_id": "img-01H…",
  "status": "in_progress",
  "polling_url": "https://.../v1/APP_ID/images/completions/img-01H…"
}
```

Terminal:

```json
{
  "job_id": "img-01H…",
  "status": "completed",
  "model": "openai/gpt-image-2",
  "polling_url": "https://.../v1/APP_ID/images/completions/img-01H…",
  "content_urls": [
    "https://.../v1/APP_ID/images/completions/img-01H…/content?index=0"
  ],
  "error": null,
  "created_at": "2026-07-15T00:00:00Z",
  "charged_credits_usd": 0.0385,
  "settled_at": "2026-07-15T00:00:04Z"
}
```

`charged_credits_usd` is `null` until the first terminal poll settles the lease. On subsequent polls the row is served from cache — the upstream is **not** re-polled.

---

## 3. Content — `GET /v1/:appId/images/completions/:jobId/content?index=N`

Streams the image bytes for the given index (`0` for single-image jobs). `Content-Type` is set from the stored row (typically `image/png` or `image/jpeg`).

- `409 JOB_NOT_COMPLETED` — poll first.
- `404 INDEX_OUT_OF_RANGE` — `N` exceeds the number of images produced.
- `502 CONTENT_UNAVAILABLE` — the upstream CDN could not serve the object (see 30-day warning below).

```bash
curl -H "Authorization: Bearer bb_sk_..." \
  "https://api.butterbase.ai/v1/APP_ID/images/completions/img-01H…/content?index=0" \
  -o out.png
```

> **⚠️ 30-day URL expiration.** Provider-hosted image URLs are guaranteed for **30 days from `created_at`**. After that the CDN returns 404 and this endpoint responds with `502 CONTENT_UNAVAILABLE`. **Download or copy the image within 30 days**, or persist it into `manage_storage` immediately after generation if you need long-term retention.

---

## 4. Billing

- The router acquires a **lease** at submit for `estimated_cost × (1 + markup_pct)`. If credits are insufficient, submit fails with `402 INSUFFICIENT_CREDITS` and no upstream call is made.
- On terminal, the router settles the lease against **actual provider cost** — preferring the upstream's reported `amount_usd`, falling back to the catalog-derived `billedImageCostUsd` when the upstream is silent. The charged amount is `provider_cost × (1 + markup_pct)` and shows on the terminal poll as `charged_credits_usd`.
- Failed jobs settle at `$0` — clients are not charged for provider-side errors.

---

## 5. Migration note for existing `/chat/completions` image users

The chat-completions path (`POST /v1/:appId/chat/completions` with an image-generation model) continues to work exactly as before. It maps to the OpenAI image-in-chat contract and returns bytes inline. Use `/images/completions` when you need:

- Multiple images per request (`n > 1`).
- Explicit `size` / `aspect_ratio` / `mask` control.
- Wan / Seedream / Pruna models — they are not addressable via chat-completions.
- Async submit + poll for long-running (>30 s) generations.
