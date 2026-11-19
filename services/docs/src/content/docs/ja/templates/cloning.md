---
title: テンプレートの複製
description: 公開Butterbaseアプリを探し、自分のアプリとして複製します。
---

テンプレートを**探す**、必要な設定を**事前確認**、**複製**して完了まで確認、の順で進めます。

<span id="step-1--find-a-template"></span>

## 手順1 — 探す

<span id="dashboard"></span>

### ダッシュボード

1. [ダッシュボード](https://dashboard.butterbase.ai)でTemplatesを開く。
2. 名前で検索するかRecent／Popularで並べ替える。人気順は複製数。
3. カードに名前・所有者・リージョンを表示。操作はCloneだけで詳細画面はないため、構成の確認には`GET /v1/templates/{app_id}`かfind_templatesを使う。

### CLI

```bash
butterbase templates
butterbase templates --q blog --sort popular --limit 20
butterbase templates --region us-west-2 --json
```

### MCP

```
manage_app action: "find_templates"
  q: "blog"
  sort: "popular"       # "recent" (default) or "popular"
  limit: 10
  offset: 0
```

`{ items: [...], total, limit, offset }`を返します。

### REST

```
GET /v1/templates?q=blog&sort=popular&limit=20&offset=0
GET /v1/templates/{app_id}
```

検索は認証不要です。詳細では内部テーブルを除いたテーブル・関数構成を返します。

:::note
**publicかつlisted**だけを表示します。publicで非掲載でもIDがあれば複製でき、限定した相手への共有に使えます。
:::

<span id="step-2--preflight"></span>

## 手順2 — 事前確認

複製前に必要な設定を取得します。無料で、公開アプリなら認証不要です。

```
GET /v1/templates/{source_app_id}/clone-preflight
```

```
manage_app action: "preview_clone_env_vars"
  source_app_id: "<app_id>"
```

```json
{
  "functions": [
    {
      "fn_name": "send-invite",
      "keys": ["BUTTERBASE_API_URL", "BUTTERBASE_API_KEY", "RESEND_API_KEY"],
      "key_meta": [
        { "key": "BUTTERBASE_API_URL", "status": "auto_filled", "reason": "Platform-resolved at clone time." },
        { "key": "BUTTERBASE_API_KEY", "status": "auto_filled", "reason": "Auto-minted bb_sk_* scoped to the new app." },
        { "key": "RESEND_API_KEY",     "status": "user_required" }
      ]
    }
  ],
  "durable_objects": { "env_keys": ["OPENAI_API_KEY"], "key_meta": [ … ] },
  "app_env": { "keys": ["FEATURE_FLAGS"], "note": "These app-level env vars are copied to the clone." }
}
```

**キー名だけを返し、元の値は渡しません。**

| status | 意味 |
|---|---|
| `auto_filled` | API URLとアプリIDを新しい値へ設定。APIキーは複製先に限定して新規発行。元に会議Webhookがあれば新規シークレットも設定。 |
| `user_required` | 自分で設定する外部シークレット。env_var_valuesで複製時、または後から指定。 |

DOのenv_keysは規約キー以外**引き継ぎません**。複製後にmanage_durable_objects set_envで設定します。

<span id="step-3--clone"></span>

## 手順3 — 複製

<span id="dashboard-1"></span>

### ダッシュボード

Cloneを押し、名前を入力します。事前確認後の環境変数画面でuser_requiredを埋められます。進捗を表示し、完了すると新アプリの概要へ移ります。

:::note
ダッシュボードは**元のリージョン**に固定します。別の場所へ置くならdest_regionを受け付けるCLI・MCP・RESTを使います。
:::

![複製中の画面。replaying_rls段階を表示](/img/templates/clone-progress.png)

### CLI

```bash
butterbase clone <source_app_id> ./my-clone --name "My App" --region us-west-2
```

新アプリを作り、最新スナップショットを./my-clone/へ取得し、.butterbase/config.jsonを新IDへ更新します。--nameと--regionは任意で、地域の省略時は元を引き継ぎます。

### MCP

```
manage_app action: "clone"
  source_app_id: "<app_id>"
  name: "My App"
  region: "us-west-2"
  env_var_values: { "send-invite": { "RESEND_API_KEY": "re_..." } }
  auto_mint_api_key: [ { "fn_name": "send-invite", "key": "BUTTERBASE_API_KEY" } ]
```

`{ job_id, status, pending_env_vars }`を返します。pending_env_varsは関数ごとの未設定キーで、空なら設定済みです。

:::note
地域が新規受付停止中で転送した場合、**POSTレスポンス**にdest_region、dest_region_redirected_from、noticeを返します。ジョブのGETには地域情報がないため、開始時に保存してください。
:::

### REST

```json
POST /v1/templates/{source_app_id}/clone
Authorization: Bearer {token}

{
  "name": "My App",
  "region": "us-west-2",
  "organization_id": "<org-uuid>",
  "env_var_values": { "send-invite": { "RESEND_API_KEY": "re_..." } },
  "auto_mint_api_key": [ { "fn_name": "send-invite", "key": "BUTTERBASE_API_KEY" } ]
}
```

| フィールド | 備考 |
|---|---|
| `name` | 任意。全体で一意で、衝突は409。省略時はClone of {source}。 |
| `dest_region` | 任意。旧名regionも受け付ける。省略時は元の地域。受付停止中なら失敗せず**受付中の地域へ転送**。[リージョン](/ja/core-concepts/regions/)を参照。 |
| `organization_id` | 任意。自分が所属する組織。認証情報の組織、次に個人組織を既定にする。 |
| `env_var_values` | `{ fn_name: { KEY: "value" } }`。新アプリ向けに暗号化して保存。 |
| `auto_mint_api_key` | `[{ fn_name, key }]`。値を渡さずスコープ付きキーを発行。 |

<span id="step-4--poll-the-job"></span>

## 手順4 — 進捗確認

```
GET /v1/clone-jobs/{job_id}
```

```
manage_app action: "get_clone_job", job_id: "<job_id>"
```

```json
{
  "job_id": "…",
  "status": "replaying_functions",
  "source_app_id": "app_src",
  "dest_app_id": null,
  "retry_count": 0,
  "error_message": null,
  "warnings": [],
  "unfilled_env_vars": { "send-invite": ["RESEND_API_KEY"] },
  "created_at": "…",
  "completed_at": null
}
```

statusはpending → processing → replaying_schema → replaying_rls → replaying_durable_objects → replaying_functions → replaying_config → copying_repo → seeding_data → completedの順です。

アプリ作成後にdest_app_idを返します。ジョブを読めるのは要求した本人だけです。

**失敗した場合：**

```
POST /v1/clone-jobs/{job_id}/retry
```

まずerror_messageを読みます。同じ処理を再試行するため、設定問題が残れば再度失敗します。

<span id="step-5--read-the-warnings"></span>

## 手順5 — 警告を読む

completedでもwarnings[]がある場合があります。処理を中止せずに回避した問題です。例：

- 認証フックの関数を再公開できず、接続をNULLのままにした。
- 元のシークレットを参照する設定をコピーしなかった。
- 会議Webhookシークレットを新規発行。wsec_*は**1回だけ**表示するため保存。

**ダッシュボードは警告を表示しません。** cloneJob付きでも概要へ移るため、一度限りのシークレットを見落とす場合があります。APIかMCPで取得してください。

```
manage_app action: "get_clone_job", job_id: "<job_id>"
```

```
GET /v1/clone-jobs/{job_id}
```

失敗時だけでなく、ダッシュボードで複製した後は毎回確認します。

<span id="errors"></span>

## エラー

| コード | HTTP | 意味 | 対処 |
|---|---|---|---|
| `RESOURCE_NOT_FOUND` | 404 | 元が存在しないか非公開 | IDを確認し、所有者に公開を依頼 |
| `VALIDATION_INVALID_SCHEMA` | 400 | スナップショットなし | 所有者がrepo pushを実行 |
| `VALIDATION_INVALID_SCHEMA` | 409 | 名前が使用済み | nameを変更 |
| `CLONE_LIMIT_INFLIGHT` | 429 | 3件実行中 | 完了まで待つ |
| rate limited | 429 | 1時間に5件超 | 待つ |
| project limit | 403 | 作成先組織の上限 | アプリ削除か[プラン更新](/ja/core-concepts/plans-and-usage/) |

<span id="next"></span>

## 次に読む

複製先は動いていても設定はまだ必要です。**[複製先の設定](/ja/templates/configure/)**を進めてください。
