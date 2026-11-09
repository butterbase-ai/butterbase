---
title: AI連携
description: OpenAI互換APIでLLMを呼び、使用量を追跡します。
---

組み込みのAIゲートウェイを通じ、OpenAI互換APIで大規模言語モデルを呼べます。

<span id="two-ways-to-call-the-gateway"></span>

## 2種類の呼び出し方

- **アプリ単位**（`/v1/{app_id}/...`）— 作成済みアプリへ紐付け、呼び出しをそのアプリのログに記録します。既定・許可モデルのアプリ設定を適用します。
- **アプリなし**（`/v1/...`）— 汎用ゲートウェイとして利用します。プラットフォームJWTかai:gatewayスコープの個人APIキーで認証し、スクリプト、CLI、OpenAI SDKなどから使えます。

リクエストとレスポンスは同じ形で、パスだけが違います。経路、エラー、個人キーの発行は[AI API](/ja/api-reference/ai-api/)を参照してください。

<span id="how-it-works"></span>

## 仕組み

チャット補完や埋め込みの利用費用を自動追跡し、プランのAIクレジットから消費します。

<span id="chat-completions"></span>

## チャット補完

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

**ストリーミング：** `"stream": true`でSSEを受け取ります。

<span id="multimodal-content"></span>

## マルチモーダル

contentは文字列または型付きコンテンツ部品の配列です。1つのメッセージにテキスト、画像、動画を含められます。

<span id="images"></span>

### 画像

公開URL、またはBase64のdata: URIを渡します。

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

モデルが対応する場合、任意のdetailで解像度を指定します（low、high、auto）。

```json
{ "type": "image_url", "image_url": { "url": "https://example.com/diagram.png", "detail": "high" } }
```

<span id="video"></span>

### 動画

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
対応はモデルによります。anthropic/claude-sonnet-4.6、anthropic/claude-opus-4.6、openai/gpt-4oなどの視覚モデルは画像を受け付けますが、動画は全モデルで使えるわけではありません。テキスト専用モデルに未対応の部品を渡すと、プロバイダーエラーになります。
:::

<span id="multiple-images"></span>

### 複数画像

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

<span id="using-butterbase-storage-urls"></span>

### Butterbase StorageのURL

保存済み画像は先に署名付きダウンロードURLを取得します。

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

<span id="embeddings"></span>

## 埋め込み

意味検索、クラスタリングなどに使うベクトルを生成します。

```json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
```

**一括入力：** 文字列の配列を渡します。

```json
{
  "model": "openai/text-embedding-3-small",
  "input": ["first text", "second text", "third text"]
}
```

<span id="available-embedding-models"></span>

### 対応する埋め込みモデル

| モデル | ID | 次元数 |
|-------|-----|------------|
| Text Embedding 3 Small | `openai/text-embedding-3-small` | 1536 |
| Text Embedding 3 Large | `openai/text-embedding-3-large` | 3072 |
| Text Embedding Ada 002 | `openai/text-embedding-ada-002` | 1536 |

<span id="video-generation"></span>

## 動画生成

チャットとは違い、動画生成は**非同期**です。30秒から数分かかるため、ジョブを作成して完了まで確認し、MP4を取得します。詳細は[動画生成](/ja/api-reference/ai-api/#video-generation)を参照してください。

動画はトークンではなく呼び出し単位で課金し、最終レスポンスのcharged_credits_usdに実費を返します。

<span id="available-models"></span>

## 利用可能なモデル

先端モデルとオープンモデルを幅広く利用できます。

| モデル | ID |
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

最新価格を含む全モデルはダッシュボードの**AI models**で確認するか、認証不要の[`GET /v1/public/models`](/ja/api-reference/ai-api/#public-model-catalog)で取得できます。

<span id="ai-configuration"></span>

## AI設定

アプリごとに設定します。

```json
PUT /v1/{app_id}/ai/config

{
  "defaultModel": "anthropic/claude-sonnet-4.6",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-sonnet-4.6", "anthropic/claude-haiku-4.5"]
}
```

| 設定 | 説明 |
|---------|-------------|
| `defaultModel` | 未指定時のモデル |
| `maxTokensPerRequest` | 1リクエストの最大トークン（1〜100,000） |
| `allowedModels` | 利用可能なモデルを制限 |

<span id="usage-tracking"></span>

## 使用量の追跡

```
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
```

合計トークン、費用、モデル別内訳を返します。

<span id="using-ai-in-serverless-functions"></span>

## 関数内で利用

BUTTERBASE_APP_IDとBUTTERBASE_API_URLは自動設定します。APIキーだけをenvVarsへ指定してください。

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

<span id="ai-credits"></span>

## AIクレジット

チャット補完と埋め込みは共通残高から消費します。利用枠、追加購入、支出上限、消費順序は[プランと使用量](/ja/core-concepts/plans-and-usage/)を参照してください。
