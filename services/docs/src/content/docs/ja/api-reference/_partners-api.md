---
title: パートナーAPI
description: パートナーのAPIキーを管理せずに、ハッカソンのパートナーAPIを呼び出します。
draft: true
---

パートナーAPIはHTTPリクエストを転送する汎用APIです。ハッカソンの参加者は、
既存のプロジェクトキー（`bb_sk_*`）でButterbaseを呼び出します。Butterbaseが
主催者のキーに置き換え、参加者へパートナーのキーを公開せずに転送します。

<span id="endpoints"></span>

## エンドポイント

### `GET /v1/{appId}/partners/{hackathonSlug}`

指定したハッカソンのパートナーAPI一覧を取得します。複数開催中でもURLのスラッグで選択できます。

**認証：** Butterbaseのプロジェクトキー。

**応答：**

```json
{
  "partners": [
    {
      "slug": "seedance",
      "display_name": "Seedance",
      "description": "AI video generation",
      "docs_url": "https://docs.seedance.ai",
      "proxy_url_template": "https://api.butterbase.ai/v1/app_abc/partners/butterbase-may-2026/seedance{path}",
      "contact_message": "DM @host on Discord.",
      "status": "available"
    }
  ]
}
```

`status: "exhausted"`はキーのプールを利用できない状態です。`contact_message`をユーザーへ表示してください。

### `ANY /v1/{appId}/partners/{hackathonSlug}/{slug}/{path...}`

元のクエリ文字列を保って`partner.base_url + /{path...}`へ転送し、
応答をストリームで返します。

**認証：** Butterbaseのプロジェクトキー。指定したハッカソンの参加者である必要があります。複数開催中でもURLのスラッグで選択します。

**ヘッダー：** `host`、`authorization`、`cookie`、標準のhop-by-hopヘッダー
（`content-length`、`connection`など）以外を転送します。プロキシが、
設定済みの`auth_template`に従ってパートナーの認証ヘッダーまたはクエリを追加します。

**本文：** JSON、multipart、octet-stream、生バイト列を、そのまま転送します。

**応答ステータス：**

| 状態 | 意味 |
| --- | --- |
| 2xx / 3xx / partner 4xx (other) / 5xx | パートナーの応答をそのまま返します。 |
| 401 / 402 / 403 / 429 from partner | プールの次のキーで最大3回再試行します。プール全体が使えない場合を除き、呼び出し元には返しません。 |
| 404 PARTNER_NOT_FOUND | このハッカソンにスラッグが登録されていません。 |
| 403 NOT_HACKATHON_PARTICIPANT | 指定したハッカソンの有効な参加者ではありません。 |
| 404 HACKATHON_NOT_FOUND | 指定したスラッグのハッカソンがありません。 |
| 503 HACKATHON_NOT_IN_WINDOW | 応募期間外です。再試行では解消しないため、別のハッカソンを選んでください。 |
| 503 PARTNER_QUOTA_EXHAUSTED | すべてのキーで利用枠が尽きました。本文の`error.remediation`に主催者の連絡先案内を含めます。 |

**例（Seedance）：**

```bash
curl -X POST https://api.butterbase.ai/v1/app_abc/partners/<hackathonSlug>/seedance/v1/video/generate \
  -H "Authorization: Bearer bb_sk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a cat dancing", "duration": 4}'
```

**例（Z.AI / 智谱）：**

```bash
curl -X POST https://api.butterbase.ai/v1/app_abc/partners/<hackathonSlug>/zhipu/api/paas/v4/chat/completions \
  -H "Authorization: Bearer bb_sk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-4","messages":[{"role":"user","content":"hi"}]}'
```

**例（Qingyun、OpenAI互換の集約サービス）：**

```bash
curl -X POST https://api.butterbase.ai/v1/app_abc/partners/<hackathonSlug>/qingyun/v1/chat/completions \
  -H "Authorization: Bearer bb_sk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

<span id="quota-exhausted-error"></span>

## 利用枠が尽きた場合

```json
{
  "error": {
    "code": "PARTNER_QUOTA_EXHAUSTED",
    "message": "The free Seedance quota for this hackathon has been used up.",
    "remediation": "DM @host on Discord.",
    "details": { "partner": "seedance" }
  }
}
```

<span id="common-gotchas"></span>

## よくある問題

<span id="powershell-51-sends-string-bodies-as-utf-16"></span>

### PowerShell 5.1の文字列の本文はUTF-16

Windows PowerShell 5.1の`Invoke-WebRequest -Body '<json>'`はJSONをUTF-16で送信します。パートナーのパーサーは各文字の後にヌル文字を受け取り、400 BadRequestなどで拒否します。対処方法は2つあります。

```powershell
# Option A: convert to UTF-8 bytes explicitly.
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-WebRequest -Method POST -Uri $uri -Headers $headers -Body $bytes -UseBasicParsing
```

```powershell
# Option B: shell out to curl.exe (Windows ships it at C:\Windows\System32\curl.exe).
curl.exe -X POST -H "Content-Type: application/json" --data-binary "@body.json" $uri
```

PowerShell 7以降は`-SkipHttpErrorCheck`に対応し、文字列の処理も改善されています。スクリプトからの利用に検討してください。

<span id="git-bash-on-windows-mangles-paths-starting-with-"></span>

### WindowsのGit Bashが`/`で始まるパスを変換する

WindowsのGit Bashでは、MSYSが`/v1/chat/completions`を`C:/Program Files/Git/v1/chat/completions`へ変換します。CLIは`Path must start with "/"`で拒否します。対処方法は2つあります。

```bash
# Option A: disable conversion just for this command.
MSYS_NO_PATHCONV=1 butterbase partners curl qingyun /v1/chat/completions \
  --hackathon my-hackathon -X POST -d '{...}' -x

# Option B: prefix with `//` — MSYS leaves anything starting `//` alone.
butterbase partners curl qingyun //v1/chat/completions \
  --hackathon my-hackathon -X POST -d '{...}' -x
```

常に無効にする場合は、`~/.bashrc`に`export MSYS_NO_PATHCONV=1`を追加します。

<span id="body-must-be-valid-json-when-content-type-applicationjson"></span>

### JSONのContent-Typeには有効なJSONが必要

本文をそのまま転送しても、`Content-Type: application/json`なら解析できるJSONが必要です。`REQUEST_ERROR: Body is not valid JSON but content-type is set to 'application/json'`の場合は、引用符や文字コード（BOM、CRLF、シェルで失われたエスケープなど）を確認してください。ファイルへ保存して`--data-binary @file`を使うと、シェルの引用符処理を避けられます。
