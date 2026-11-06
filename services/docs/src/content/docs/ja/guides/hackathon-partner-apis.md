---
title: ハッカソンのパートナーAPI
description: パートナーのキーを管理せず、Seedance、Z.AIなどの協賛APIを呼び出します。
draft: true
---

Butterbaseのハッカソンでは、主催者がパートナーのキーを登録します。
自分のコードは通常のプロジェクトキーでButterbaseを呼び出し、
パートナー側の認証をButterbaseが処理します。

<span id="what-you-need-before-you-start"></span>

## 事前準備

- **ハッカソンのスラッグ**：URLの識別子（例：butterbase-may-2026）。主催者やダッシュボードで確認します。
- **提出コード**：主催者が提供します。初回の提出でアカウントを紐付けます。
- **サービスキー**（bb_sk_…）：ダッシュボードやmanage_auth_configのgenerate_service_keyで発行し、Authorization: Bearerへ指定します。
- **app_id**：対象のアプリID。ダッシュボードやmanage_appのlistで確認します。

<span id="1-discover-whats-available"></span>

## 1. 利用できるAPIの確認

```ts
const { data: partners } = await bb.partners.list('your-hackathon-slug');
console.table(partners);
```

CLIの場合：

```bash
butterbase partners list --hackathon your-hackathon-slug --app app_xxxxxxxxxxxx
```

seedance（動画）、zhipu（Z.AIのチャット）、qingyun（GPT、Claude、Gemini、画像、動画、音楽のOpenAI互換）などを表示します。

<span id="2-call-a-partner"></span>

## 2. 呼び出し

プロキシのURL：

```
${BUTTERBASE_URL}/v1/${APP_ID}/partners/${HACKATHON_SLUG}/${PARTNER_SLUG}/${PARTNER_PATH}
```

パートナーに直接送る場合と同じ本文を、`Authorization: Bearer <your bb_sk_ key>`で送ります。プロキシが認証ヘッダーを置き換え、他の内容をそのまま転送します。

**SDK：QingyunのOpenAI互換チャット：**

```ts
const res = await bb.partners.fetch(
  'your-hackathon-slug',
  'qingyun',
  '/v1/chat/completions',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Suggest 3 hackathon ideas about cats.' }],
    }),
  },
);
const { choices } = await res.json();
```

**CLI：同じ呼び出し：**

```bash
butterbase partners curl qingyun /v1/chat/completions \
  --hackathon your-hackathon-slug --app app_xxxxxxxxxxxx \
  -X POST \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}' \
  -x
```

`-x`で実行します。省略するとキーを伏せたcurlの例を表示します。

**SDK：Z.AI / 智谱のチャット：**

```ts
const res = await bb.partners.fetch(
  'your-hackathon-slug',
  'zhipu',
  '/api/paas/v4/chat/completions',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-4',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  },
);
```

<span id="3-handle-the-quota-exhausted-case"></span>

## 3. 利用枠が尽きた場合

共有のキーには利用枠があります。すべて使えなくなると次を返します。

```json
{ "error": { "code": "PARTNER_QUOTA_EXHAUSTED",
             "message": "The free Seedance quota for this hackathon has been used up.",
             "remediation": "DM @host on Discord." } }
```

remediationをユーザーに表示し、主催者への追加枠の問い合わせ方法を案内してください。

```ts
if (!res.ok) {
  const err = await res.json();
  if (err.error?.code === 'PARTNER_QUOTA_EXHAUSTED') {
    showToast(err.error.remediation);
  } else {
    throw err;
  }
}
```

<span id="what-does-not-happen"></span>

## キーと利用枠の扱い

- パートナーのキーはアプリやユーザーに公開しません。
- 利用枠はパートナーが管理します。キーが使えなくなると、
  Butterbaseが次のキーへ切り替えます。
- プロジェクトごとの枠はなく、全参加者で共有します。

<span id="troubleshooting"></span>

## 問題の解決

パートナーに到達する前の失敗には次があります。

| 状態 | コード | 意味 |
|---|---|---|
| 404 | `HACKATHON_NOT_FOUND` | URLのスラッグが見つかりません。名前を確認してください。 |
| 503 | `HACKATHON_NOT_IN_WINDOW` | 応募期間外です。**再試行では解消しません。** |
| 403 | `NOT_HACKATHON_PARTICIPANT` | 認証済みですが参加者ではありません。提出の手順でアカウントを紐付けてください。 |
| 404 | `PARTNER_NOT_FOUND` | パートナーのスラッグがありません。partners.listで確認してください。 |
| 503 | `PARTNER_QUOTA_EXHAUSTED` | 全キーを利用できません。error.remediationで主催者の連絡先を案内してください。 |
| 400 | `REQUEST_ERROR` ("Body is not valid JSON…") | 本文をJSONとして解析できません。Windowsの引用符処理などを[注意点](/ja/api-reference/partners-api#common-gotchas)で確認してください。 |

PowerShellのUTF-16、Git Bashのパス変換、JSONの引用符は[APIの注意点](/ja/api-reference/partners-api#common-gotchas)を参照してください。
