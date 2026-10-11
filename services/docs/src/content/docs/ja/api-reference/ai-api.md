---
title: AI API
description: AIモデルゲートウェイのエンドポイントを説明します。
sidebar:
  order: 6
---

Butterbaseは、チャット補完、埋め込み、モデル一覧のOpenAI互換APIを提供します。呼び出し方は2つあります。

- **アプリ単位**：`/v1/{app_id}/...`を使います。料金はアプリの所有者に請求し、アプリのAI設定（既定のモデル、許可するモデル）を適用します。
- **ゲートウェイモード**：`app_id`なしの`/v1/...`を使い、プラットフォームJWTまたは個人APIキーで認証します。アプリを作らずにOpenAI互換ゲートウェイを利用したい場合に使います。

<span id="app-scoped-endpoints"></span>

## アプリ単位のエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/chat/completions | チャット補完（OpenAI互換） |
| POST | /v1/\{app_id}/embeddings | 埋め込みを生成 |
| GET | /v1/\{app_id}/ai/config | AI設定を取得 |
| PUT | /v1/\{app_id}/ai/config | AI設定を更新 |
| GET | /v1/\{app_id}/ai/usage | AI使用量を取得 |

<span id="gateway-endpoints-no-app-required"></span>

## ゲートウェイのエンドポイント（アプリ不要）

| メソッド | パス | 用途 | 認証 |
|--------|------|---------|------|
| POST | /v1/chat/completions | チャット補完 | 必須 |
| POST | /v1/embeddings | 埋め込みを生成 | 必須 |
| GET | /v1/models | モデル一覧（OpenAI形式） | 必須 |
| GET | /v1/public/models | 料金付きの公開モデル一覧 | 不要 |

OpenAI SDKの`baseURL`を`https://api.butterbase.ai/v1`にし、個人APIキーをBearerトークンに指定すると利用できます。リクエストと応答の形式はアプリ単位の場合と同じで、パスだけが異なります。

<span id="chat-completions-gateway"></span>

### チャット補完（ゲートウェイ）

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

Server-Sent Eventsを使うには`"stream": true`を指定します。

<span id="embeddings-gateway"></span>

### 埋め込み（ゲートウェイ）

```json
POST /v1/embeddings
Authorization: Bearer bb_sk_...

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
```

<span id="list-models"></span>

### モデル一覧

```json
GET /v1/models
Authorization: Bearer bb_sk_...
```

応答：

```json
{
  "object": "list",
  "data": [
    { "id": "anthropic/claude-3.5-sonnet", "object": "model", "display_name": "Claude 3.5 Sonnet" },
    { "id": "openai/gpt-4o", "object": "model", "display_name": "GPT-4o" }
  ]
}
```

<span id="public-model-catalog"></span>

### 公開モデル一覧

**認証なし**で料金とコンテキスト長を含むモデル一覧を取得する専用APIです。ドキュメント、モデル選択画面、ログイン前にモデルを取得するツールなどに使えます。

```
GET /v1/public/models
```

Authorizationヘッダーは不要です。

応答：

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

料金は100万トークンあたりの金額で、モデルを呼び出すときの請求額を表します。コンテキスト長を報告しないモデルでは、`contextWindow`が`null`の場合があります。

<span id="authentication"></span>

### 認証

プラットフォームJWT（ダッシュボードなどのセッションを使うクライアント）または個人APIキーで認証します。個人キーには`ai:gateway`スコープが必要です。[個人APIキー](#personal-api-keys)を参照してください。

<span id="errors"></span>

### エラー

エラーはOpenAI互換の形式で返します。

```json
{ "error": { "message": "...", "type": "...", "code": "..." } }
```

| 状態 | `error.type` | `error.code` | 発生条件 |
|---|---|---|---|
| 401 | `authentication_error` | `missing_credentials` | Authorizationヘッダーがありません。 |
| 401 | `authentication_error` | `invalid_api_key` | トークンが不明、失効済み、または期限切れです。 |
| 403 | `permission_error` | `insufficient_scope` | APIキーに`ai:gateway`スコープがありません。 |
| 402 | `billing_error` | `insufficient_credits` | 呼び出しに必要な残高がありません。 |
| 404 | `invalid_request_error` | `model_not_found` | 指定したモデルIDを利用できません。 |
| 400 | `invalid_request_error` | `invalid_request` | 本文の検証に失敗しました。 |
| 5xx | `api_error` | (varies) | プロバイダーの一時的な問題です。間隔を空けて再試行してください。 |

<span id="chat-completions"></span>

## チャット補完

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

標準のOpenAI互換の応答形式です。Server-Sent Eventsには`"stream": true`を指定します。

<span id="embeddings"></span>

## 埋め込み

```json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
```

| パラメーター | 説明 |
|-----------|-------------|
| `model` | 埋め込みモデルのID（必須） |
| `input` | 文字列または文字列の配列（必須） |
| `encoding_format` | `"float"`（既定値）または`"base64"` |

<span id="available-embedding-models"></span>

### 利用できる埋め込みモデル

| モデル | ID | 次元数 |
|-------|-----|------------|
| Text Embedding 3 Small | `openai/text-embedding-3-small` | 1536 |
| Text Embedding 3 Large | `openai/text-embedding-3-large` | 3072 |
| Text Embedding Ada 002 | `openai/text-embedding-ada-002` | 1536 |

<span id="video-generation"></span>

## 動画生成

動画生成は**非同期**です。ジョブを送信し、状態を確認してから完成したデータをダウンロードします。通常はモデルと長さに応じて30秒から数分かかります。

<span id="endpoints"></span>

### エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/videos/completions | 生成ジョブを送信 |
| GET | /v1/\{app_id}/videos/completions/\{job_id} | 状態を確認（終了状態になればダウンロードも処理） |
| GET | /v1/\{app_id}/videos/completions/\{job_id}/content?index=N | 生成したMP4を取得 |

<span id="choosing-a-model"></span>

### モデルの選択

動画モデルはチャット・埋め込みモデルとともに`GET /v1/{app_id}/ai/models`に含まれます。動画用のプロバイダープレフィックス（例：`bytedance/seedance-…`、`kwaivgi/kling-…`、`pixverse/…`、`google/veo-…`）で探してください。動画モデルを`/chat/completions`へ送ると、正しいURLを含む`400 USE_VIDEO_ENDPOINT`を返します。

<span id="1-submit-a-job"></span>

### 1. ジョブの送信

**curl：**

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

**TypeScript（fetch）：**

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

**Python（requests）：**

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

**応答（202 Accepted）：**

```json
{
  "job_id": "5cd4be3e-c65e-4524-97cf-4595a76e2096",
  "status": "pending",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-c65e-4524-97cf-4595a76e2096"
}
```

**リクエストのフィールド：**

| フィールド | 必須 | 説明 |
|-------|----------|-------------|
| `model` | はい | 動画モデルのID（上記の「モデルの選択」を参照） |
| `prompt` | はい | 生成する動画の説明文 |
| `duration` | いいえ | 秒単位の長さ。モデルごとに異なります（一般的な値は4、6、8）。 |
| `resolution` | いいえ | 例：`720p`、`1080p`。モデルごとに異なります。 |
| `aspect_ratio` | いいえ | 例：`16:9`、`9:16`、`1:1`。モデルごとに異なります。 |
| `generate_audio` | いいえ | 真偽値。動画と同時に音声を生成できるモデルで使います。 |
| `seed` | いいえ | 生成を再現するための整数。対応しないプロバイダーもあります。 |
| `input_images` | いいえ | 画像からの動画生成や最初のフレームの参考に使うHTTPS画像URLの配列 |

<span id="2-poll-for-status"></span>

### 2. 状態の確認

`polling_url`を30秒間隔で確認し、`status`が終了状態（`completed`、`failed`、`cancelled`、`expired`）になるまで続けます。

**curl：**

```bash
curl "https://api.butterbase.ai/v1/$APP_ID/videos/completions/$JOB_ID" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

**TypeScript：**

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

**Python：**

```python
import time, requests
def poll(job_url, api_key):
    while True:
        job = requests.get(job_url, headers={"Authorization": f"Bearer {api_key}"}).json()
        if job["status"] in {"completed", "failed", "cancelled", "expired"}:
            return job
        time.sleep(30)
```

**応答（`completed`の場合）：**

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

- 複数の候補を生成するモデルがあるため、`content_urls`は配列です。`?index=N`で選択します。
- `charged_credits_usd`はジョブの確定時（終了状態の最初の確認時）に設定します。待機中・処理中は`null`です。
- `status: "failed"`の場合、`error`にプロバイダーのメッセージを含めます。

<span id="3-download-the-video"></span>

### 3. 動画のダウンロード

`content_urls`は絶対URLで、同じBearer APIキーが必要です。`video/mp4`のデータをストリームで返します。

**curl：**

```bash
curl -L "$CONTENT_URL" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  --output video.mp4
```

**TypeScript：**

```typescript
const mp4 = await fetch(job.content_urls[0], { headers: { Authorization: `Bearer ${apiKey}` } });
const buf = Buffer.from(await mp4.arrayBuffer());
fs.writeFileSync('video.mp4', buf);
```

**Python：**

```python
import requests
with requests.get(job["content_urls"][0],
                  headers={"Authorization": f"Bearer {api_key}"}, stream=True) as r:
    with open("video.mp4", "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)
```

<span id="error-codes"></span>

### エラーコード

| 状態 | コード | 意味 |
|--------|------|---------|
| 400 | `USE_VIDEO_ENDPOINT` | 動画モデルを`/chat/completions`へ送信しています。`/videos/completions`を使ってください。 |
| 400 | `INVALID_INDEX` | `?index=`が0以上の整数ではありません。 |
| 402 | `INSUFFICIENT_CREDITS` | 残高が組織の利用可能下限未満です。`balance_usd`（月間利用枠と追加購入分の合計）、`credit_floor_usd`（与信がなければ0）、自動補充の状態を返します。 |
| 403 | `FORBIDDEN` | このジョブの作成者ではありません。 |
| 404 | `MODEL_NOT_FOUND` | 不明なモデルIDです。 |
| 404 | `JOB_NOT_FOUND` | 不明なジョブID、または別のアプリのジョブです。 |
| 409 | `JOB_NOT_COMPLETED` | `completed`になる前に`/content`を呼び出しています。 |
| 502 | `MODEL_UNAVAILABLE` | プロバイダーが一時的に利用できません。再試行してください。 |

<span id="jobs-survive-across-polls"></span>

### ジョブの永続化

ジョブは永続化されるため、別のクライアントやプロセスからも確認できます。メモリ内の状態には依存しません。`polling_url`を紛失した場合は`https://api.butterbase.ai/v1/{app_id}/videos/completions/{job_id}`を使ってください。

完了前に確認をやめると、数分後にクレジットの予約が自動で解除されます。発生したプロバイダーの料金はButterbaseが負担します。後から動画を取得できるとは限らないため、必要なら再送信してください。

<span id="image-generation"></span>

## 画像生成

画像生成も、非同期の送信・確認・ダウンロードで行います。多くのモデルは5〜30秒で完了します。画像専用APIは、`/chat/completions`では表せない`size`、`aspect_ratio`、`seed`、`n`、参照画像、マスクなどの指定に対応します。

<span id="endpoints-1"></span>

### エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/images/completions | 生成ジョブを送信 |
| GET | /v1/\{app_id}/images/completions/\{job_id} | ジョブの状態を確認 |
| GET | /v1/\{app_id}/images/completions/\{job_id}/content?index=N | 生成したPNG・JPEGを取得 |

<span id="choosing-a-model-1"></span>

### モデルの選択

画像モデルもチャット・動画とともに`GET /v1/{app_id}/ai/models`に含まれます。公開時点の対応モデルは次のとおりです。

| 系列 | モデルID |
|--------|-----------|
| OpenAI | `openai/gpt-image-2`, `openai/gpt-image-1`, `openai/gpt-image-1-mini` |
| Google (Nano Banana) | `google/gemini-3-pro-image-preview`, `google/gemini-3.1-flash-image-preview`, `google/gemini-2.5-flash-image` |
| ByteDance Seedream | `bytedance/seedream-5-pro`, `bytedance/seedream-5-lite`, `bytedance/seedream-4-5` |
| Alibaba Wan | `alibaba/wan-2.7-image-pro`, `alibaba/wan-2.7-image`, `alibaba/wan-2.6-t2i`, `alibaba/wan-2.6-image` |
| PrunaAI | `prunaai/p-image`, `prunaai/p-image-edit` |

使えるパラメーターは**モデルごとに異なります**。未対応の指定は無視せず、対応する全パラメーターを含む`400 UNSUPPORTED_PARAM`を返します。

<span id="1-submit-a-job-1"></span>

### 1. ジョブの送信

**curl：**

```bash
curl -X POST "https://api.butterbase.ai/v1/$APP_ID/images/completions" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-image-2",
    "prompt": "A serene mountain lake at sunset, photorealistic",
    "size": "1024x1024",
    "n": 1
  }'
```

**TypeScript（fetch）：**

```typescript
const res = await fetch(`${BUTTERBASE_API_URL}/v1/${APP_ID}/images/completions`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'google/gemini-3-pro-image-preview',
    prompt: 'A serene mountain lake at sunset, photorealistic',
    aspect_ratio: '16:9',
  }),
});
const job = await res.json();
// { job_id, status: 'pending', polling_url }
```

**Python（requests）：**

```python
import os, requests
res = requests.post(
    f"{os.environ['BUTTERBASE_API_URL']}/v1/{APP_ID}/images/completions",
    headers={"Authorization": f"Bearer {os.environ['BUTTERBASE_API_KEY']}"},
    json={
        "model": "alibaba/wan-2.7-image-pro",
        "prompt": "A cat wearing a spacesuit",
        "size": "2K",
        "seed": 42,
    },
)
job = res.json()
# {"job_id": "...", "status": "pending", "polling_url": "..."}
```

**応答（202 Accepted）：**

```json
{
  "job_id": "0776b4a1-aef9-4fbc-8ac6-18255aa18614",
  "status": "pending",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/images/completions/0776b4a1-aef9-4fbc-8ac6-18255aa18614"
}
```

**リクエストのフィールド：**

| フィールド | 必須 | 説明 |
|-------|----------|-------------|
| `model` | はい | 画像モデルのID（上の表を参照） |
| `prompt` | はい | 生成する画像の説明文 |
| `size` | いいえ | 例：`1024x1024`、`1536x1024`、`1K`、`2K`、`4K`。モデルごとに異なります。 |
| `aspect_ratio` | いいえ | 例：`16:9`、`1:1`。GeminiとPrunaのみ。 |
| `n` | いいえ | 生成枚数。GPT Image 2・1・1-miniのみ。 |
| `seed` | いいえ | 生成を再現するための整数。Wan、Pruna、GPT Image 2、一部のOpenRouterモデルに対応。 |
| `input_images` | いいえ | 変換や参照に使うHTTPS画像URLの配列（多くのモデルで最大14件） |
| `mask` | いいえ | 編集用アルファマスクのHTTPS URL。GPT Image 2のみ。 |
| `negative_prompt` | いいえ | 生成で避けたい内容の説明文。Wan 2.6のみ。 |
| `provider` | いいえ | モデル固有の設定（Wanの`bbox_list`・`color_palette`、GPTの`quality`・`background`、Seedreamの`optimize_prompt_options`など）。モデルが対応する設定の一覧で検証します。 |

**画像URLの別名：** トップレベルの`image`、`image_url`、`image_uri`、`reference_image`、`input_image`、`starting_image`は、検証前に`input_images[]`へまとめます。`mask`は独立したトップレベルのフィールドです。

<span id="2-poll-for-status-1"></span>

### 2. 状態の確認

`polling_url`を2〜5秒間隔で確認し、`status`が終了状態（`completed`、`failed`、`cancelled`、`expired`）になるまで続けます。

**curl：**

```bash
curl "https://api.butterbase.ai/v1/$APP_ID/images/completions/$JOB_ID" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

**TypeScript：**

```typescript
async function poll(jobUrl: string, apiKey: string) {
  while (true) {
    const res = await fetch(jobUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const job = await res.json();
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 2_000));
  }
}
```

**Python：**

```python
import time, requests
def poll(job_url, api_key):
    while True:
        job = requests.get(job_url, headers={"Authorization": f"Bearer {api_key}"}).json()
        if job["status"] in {"completed", "failed", "cancelled", "expired"}:
            return job
        time.sleep(2)
```

**応答（`completed`の場合）：**

```json
{
  "job_id": "0776b4a1-aef9-4fbc-8ac6-18255aa18614",
  "status": "completed",
  "model": "openai/gpt-image-2",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/images/completions/0776b4a1-...",
  "content_urls": [
    "https://api.butterbase.ai/v1/{app_id}/images/completions/0776b4a1-.../content?index=0"
  ],
  "error": null,
  "created_at": "2026-07-15T02:57:44.271Z",
  "charged_credits_usd": 0.010168,
  "settled_at": "2026-07-15T02:58:04.512Z"
}
```

- `content_urls`は配列です。GPT Imageで`n > 1`の場合、生成画像ごとに1件を含めます。
- `charged_credits_usd`はジョブの確定時（終了状態の最初の確認時）に設定します。待機中・処理中は`null`です。
- `status: "failed"`の場合、`error`にプロバイダーのメッセージを含めます。

<span id="3-download-the-image"></span>

### 3. 画像のダウンロード

`content_urls`は絶対URLで、同じBearer APIキーが必要です。PNGまたはJPEGのデータを返します。形式はモデルやリクエストで異なるため、`Content-Type`を確認してください。

**curl：**

```bash
curl -L "$CONTENT_URL" \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \
  --output image.png
```

**TypeScript：**

```typescript
const img = await fetch(job.content_urls[0], { headers: { Authorization: `Bearer ${apiKey}` } });
const buf = Buffer.from(await img.arrayBuffer());
// Content-Type header tells you the format: image/png, image/jpeg, image/webp
```

<span id="errors-1"></span>

### エラー

動画生成と同じ分類に加え、画像用のエラーコードがあります。

| 状態 | コード | 意味 |
|--------|------|---------|
| 400 | `UNSUPPORTED_PARAM` | モデルが対応しない設定です。本文に`supported_top_level`と`supported_provider`を返します。 |
| 400 | `WRONG_MODALITY` | 画像モデルではありません（チャット・動画モデルなど）。 |
| 402 | `INSUFFICIENT_CREDITS` | アプリのクレジットが不足しています。 |
| 404 | `JOB_NOT_FOUND` | jobIdがないか、別のエンドユーザーのジョブです。 |
| 409 | `JOB_NOT_COMPLETED` | 終了状態になる前に`/content`を呼び出しています。 |
| 502 | `MODEL_UNAVAILABLE` | プロバイダーが一時的に利用できません。再試行してください。 |

<span id="notes-on-url-expiration"></span>

### URLの有効期限

コンテンツURLはプロバイダーのストレージを指し、通常は生成から**約30日**で失効します。長く保存する場合は、期限内に画像をダウンロードし、自分のバケット（Butterbase Storageなど）へ保存してください。

<span id="concurrency"></span>

### 同時実行

Butterbase側にはアプリ・キーごとの同時実行数の上限はありません。クレジット残高の範囲で並行してPOSTし、返された`job_id`を個別に確認できます。モデルのプロバイダーのレート制限に達すると、そのエラーを含む429を返します。

<span id="configuration"></span>

## 設定

```json
PUT /v1/{app_id}/ai/config

{
  "defaultModel": "anthropic/claude-3.5-sonnet",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-3.5-sonnet"]
}
```

| フィールド | 説明 |
|-------|-------------|
| `defaultModel` | モデルを省略した場合に使うモデル |
| `maxTokensPerRequest` | リクエストあたりのトークン上限（1〜100,000） |
| `allowedModels` | 利用できるモデルを制限 |

<span id="usage"></span>

## 使用量

```
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
```

**応答：**

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

<span id="personal-api-keys"></span>

## 個人APIキー

スクリプト、CLI、OpenAI SDKなど、ダッシュボード外からゲートウェイを使うには、`ai:gateway`スコープの個人APIキーを発行します。

```json
POST /api-keys
Authorization: Bearer {jwt}

{
  "name": "my-cli",
  "scopes": ["ai:gateway"]
}
```

平文のキーは応答で1回だけ返します。すぐに保存してください。以降はプレフィックスだけを表示します。

<span id="scopes"></span>

### スコープ

| スコープ | 権限 |
|---|---|
| `*` | ユーザーが利用できるすべてのButterbase API |
| `ai:gateway` | `POST /v1/chat/completions`、`POST /v1/embeddings`、`GET /v1/models`だけを利用可能 |

ダッシュボードの`/api-keys`で一覧と失効の操作ができます。`ai:gateway`を指定するには、`POST /api-keys`を直接呼び出します。

<span id="meeting-bots"></span>

## 会議ボット

`ctx.ai.meetings`でZoom、Google Meet、Microsoft Teams、Webexへ参加し、録画と文字起こしを行うボットを起動できます。REST APIまたはSDKで開始し、会議終了と成果物の準備をWebhookで確認します。料金はAIクレジットから差し引きます。以下のサンプルは元の英語ページにある旧仕様です。現在のアプリ単位のパス、応答コード、署名検証は[AI会議API](/ja/api-reference/ai-meetings-api/)を参照してください。

<span id="endpoints-2"></span>

### エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/ai/meetings | ボットを起動（旧パス） |
| GET | /v1/ai/meetings/\{bot_id} | ボットの状態と成果物のURLを取得（旧パス） |
| DELETE | /v1/ai/meetings/\{bot_id} | ボットを停止（旧パス） |
| GET | /v1/ai/meetings | ボット一覧を取得（旧パス） |
| GET | /v1/ai/meetings/_estimate | 料金を見積もる（旧パス） |

<span id="start-a-bot"></span>

### ボットの起動

**リクエスト：**

```json
POST /v1/ai/meetings
Authorization: Bearer bb_sk_...

{
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "transcript": true,
  "recording": "mp4",
  "metadata": {
    "dealId": "d_42"
  }
}
```

**リクエストのフィールド：**

| フィールド | 型 | 必須 | 既定値 | 説明 |
|-------|------|----------|---------|-------------|
| `meetingUrl` | string | はい | — | 参加する会議の完全なURL |
| `transcript` | boolean | いいえ | `true` | 文字起こしを生成するかどうか |
| `recording` | `"mp4" \| "audio_only" \| false` | いいえ | `"mp4"` | 録画形式。`false`なら録画しません。 |
| `metadata` | `Record<string, string>` | いいえ | `{}` | 任意のキーと値。`bb_`で始まるキーは予約済みで、400になります。 |

**応答（201 Created、旧仕様）：**

```json
{
  "id": "bot_01j9...",
  "status": "joining",
  "startedAt": null,
  "completedAt": null,
  "durationSeconds": null,
  "recordingUrl": null,
  "transcriptUrl": null,
  "metadata": {
    "dealId": "d_42"
  }
}
```

ボットを返す各エンドポイントで`MeetingBot`の形式は共通です。

<span id="bot-status-lifecycle"></span>

### ボットの状態

ボットは次の状態を経て進行します。

| 状態 | 意味 |
|--------|---------|
| `joining` | 会議に接続中 |
| `waiting_room` | 待機室で許可待ち |
| `in_call` | 会議に参加済み |
| `recording` | 録画中（有効なら文字起こしも実行） |
| `ended` | 会議が終了し、成果物を処理中 |
| `done` | 成果物を取得可能。`recordingUrl`と、該当する場合は`transcriptUrl`を設定。 |
| `fatal` | 復旧できないエラー。状態と`bot.fatal`のWebhookを確認。 |

<span id="sdk-usage"></span>

### SDKの使用例

```ts
import { butterbase } from '@butterbase/sdk';

const bb = butterbase({ apiKey: '...', appId: '...' });

// Start a bot
const { data: bot, error } = await bb.ai.meetings.start({
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  transcript: true,
  recording: 'mp4',
  metadata: { dealId: 'd_42' },
});

// Later, after the webhook tells you the bot is done:
const { data: finished } = await bb.ai.meetings.get(bot!.id);
// finished.recordingUrl + finished.transcriptUrl are now populated
```

その他のSDKメソッド：

```ts
// Stop a bot early
await bb.ai.meetings.stop(bot!.id);

// List bots with optional filters
const { data: bots } = await bb.ai.meetings.list({ status: 'done', limit: 20, cursor: '...' });

// Estimate cost before dispatching
const { data: estimate } = await bb.ai.meetings.estimateCost({ durationMinutes: 60, transcript: true });
// estimate.usd — projected total charge
```

<span id="pricing"></span>

### 料金

元のページの料金例は、録画が**1時間あたり0.50米ドル＋上乗せ料金**、文字起こしが**1時間あたり0.15米ドル＋上乗せ料金**で、いずれも秒単位の按分です。`done`になったときにAIクレジットから差し引きます。実際の環境の料金は見積もりAPIで確認してください。

現在の見積もりAPIは`GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes=N&transcript=true`です。起動前に確認できます。

<span id="webhook-events"></span>

### Webhookイベント

`manage_ai`の`configure_meetings_webhook`で設定したURLにイベントを転送します。Butterbaseが転送前に署名を付けます。

**イベントの種類：**

| イベント | 発生条件 |
|-------|---------------|
| `bot.in_call_recording` | 入室が許可され、録画を開始 |
| `bot.done` | ボットが退出し、録画を取得可能 |
| `bot.fatal` | ボットの失敗。状態を確認 |
| `recording.done` | 録画をダウンロード可能 |
| `transcript.done` | 文字起こしをダウンロード可能 |
| `transcript.failed` | 文字起こしに失敗 |

**本文の形式：**

```json
POST <your-forward-url>
Content-Type: application/json
x-bb-event: bot.done
x-bb-signature: v1,<base64>
x-bb-key-id: <16-char identifier>

{
  "event": "bot.done",
  "data": { /* event-specific payload */ }
}
```

<span id="signature--freshness"></span>

### 署名と重複の確認

現在の署名方式は、アプリごとのシークレットによるHMAC-SHA256です。受信した本文の生バイト列から署名を計算し、`x-bb-signature`と定数時間で比較してください。`x-bb-key-id`の一致だけでは署名の検証にはなりません。[AI会議APIの署名検証](/ja/api-reference/ai-meetings-api/#verifying-the-signature)に計算式を掲載しています。

**重複配信でデータベースへの書き込みや外部呼び出しを繰り返さないでください。** 本文の`bot.id`とイベント名を組み合わせて冪等キーにします。プロバイダーの配信サービスは最大24時間再試行する場合があります。

<span id="limits"></span>

### 制約

- **単一リージョン。** v1のボットは米国東部のワークスペースから起動します。複数リージョンへのルーティングは計画中です。
- **会議時間の固定上限なし。** 会議が終了するかAIクレジット残高が尽きるまで動作します。
- **成果物の保存期間。** 元のページでは終了後7日間です。期限までに録画と文字起こしをダウンロードしてください。
