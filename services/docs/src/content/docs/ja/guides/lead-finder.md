---
title: 見込み客の検索
description: 人物と企業を検索し、プロフィールと勤務先メールを取得します。料金はButterbaseクレジットから支払います。
sidebar:
  order: 12
---

人物検索で、人物・企業の検索、プロフィールの情報補完、勤務先メールの取得を行います。外部のAPIキーは不要で、料金はButterbaseクレジットから差し引きます。

このガイドは一連の検索機能を作成する手順です。詳細は[人物検索API](/ja/api-reference/people-api/)と[MCPのmanage_people](/ja/api-reference/mcp-tools/#people-people--company-search--enrichment)を参照してください。

<span id="what-you-can-build"></span>

## 作れる機能

- **見込み客の一覧**：役職、企業、場所、学歴、自然言語の条件で検索し、保存。
- **プロフィール補完**：LinkedIn URLから氏名、紹介、職歴、学歴を取得。
- **勤務先メール**：LinkedIn URLから非同期で検索。
- **CRMの情報補完**：保存済みの連絡先のプロフィールを追加。

<span id="quick-start"></span>

## クイックスタート

<span id="natural-language-query"></span>

### 自然言語の検索

`query`へ探す相手の説明を指定します。

```jsonc
// MCP
{
  "tool": "manage_people",
  "action": "search_person",
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "page_size": 25
}
```

```bash
# REST
curl -X POST https://api.butterbase.ai/v1/$APP_ID/people/search/person \
  -H "Authorization: Bearer $BB_SK" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "founder of a YC-backed AI startup based in San Francisco",
    "pageSize": 25
  }'
```

<span id="structured-filters"></span>

### 構造化したフィルター

`query`の代わり、または一緒に個別のフィルターを指定できます。両方ある場合はqueryを優先します。

```jsonc
// MCP
{
  "tool": "manage_people",
  "action": "search_person",
  "current_role_title": "(VP OR \"Vice President\") AND NOT assistant",
  "education_school_name": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "page_size": 25
}
```

```bash
# REST
curl -X POST https://api.butterbase.ai/v1/$APP_ID/people/search/person \
  -H "Authorization: Bearer $BB_SK" \
  -H "Content-Type: application/json" \
  -d '{
    "currentRoleTitle": "(VP OR \"Vice President\") AND NOT assistant",
    "educationSchoolName": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
    "country": "US",
    "pageSize": 25
  }'
```

最大25件と、条件全体の`totalResultCount`、次ページの`nextPage`を返します。

<span id="structured-filter-syntax"></span>

## フィルターの書式

文字列内で論理演算子を使えます。

- `OR`：いずれか（`(CTO OR "VP Engineering")`）。
- `AND`：複数の条件（`senior AND engineer`）。
- `NOT`：除外（`engineer AND NOT intern`）。
- 二重引用符：複数語のまとまり（`"Vice President"`）。
- 括弧：グループ（`(VP OR Director) AND NOT assistant`）。

厳密に適用できるかはプロバイダーによります。意味検索では順位の参考に使うため、環境ごとに動作が異なります。

<span id="cost-preview-before-paginating"></span>

## 全件取得前の料金確認

`page_size: 1`で`totalResultCount`を確認します。

```jsonc
{ "action": "search_person", "current_role_title": "CTO", "country": "US", "page_size": 1 }
// → { data: { totalResultCount: 12345, ... }, usage: { creditsConsumed: 7, usdCharged: 0.0084 } }
```

件数と[料金の目安](/ja/api-reference/people-api/#pricing)に基づいてページ数を決めます。

<span id="end-to-end-flow"></span>

## 一連の流れ

典型的な検索機能は次の流れです。

<span id="1-user-describes-the-audience"></span>

### 1. 対象の説明

UIで「米国の従業員200人未満のフィンテック企業の開発責任者」のように入力します。

<span id="2-translate-to-a-search"></span>

### 2. 検索条件への変換

説明をqueryへ送る、フォームで指定する、AIゲートウェイでフィルターへ変換する方法があります。

```jsonc
// Option A — pass directly as query
{
  "action": "search_person",
  "query": "VPs of engineering at fintech startups under 200 people, US-based",
  "page_size": 25
}

// Option B — AI gateway converts NL → filters
{
  "tool": "manage_ai",
  "action": "chat",
  "messages": [
    { "role": "system", "content": "Convert the user's audience description into a search_person filter object. Available fields: current_role_title, past_role_title, current_company_name, current_company_industry, country, region, city, education_school_name, education_degree_name, education_field_of_study. All fields accept boolean syntax. Reply with ONLY a JSON object." },
    { "role": "user", "content": "VPs of engineering at fintech startups under 200 people, US-based" }
  ]
}
// → '{ "current_role_title": "(VP OR \"Vice President\") AND engineering", "current_company_industry": "Financial Services", "country": "US" }'
```

先に企業を絞る場合は`employee_count_max: 200`の`search_company`と組み合わせ、その企業の人物を検索します。

<span id="3-probe--show-estimated-cost"></span>

### 3. 件数と見積もりの表示

page_sizeを1にし、全件数と次のNページの費用を表示します。実行前に条件を調整できるようにします。

<span id="4-paginate-the-results"></span>

### 4. 次のページの取得

```jsonc
{ "action": "search_person", "current_role_title": "...", "page_size": 25 }
// → { data: { results: [...], nextPage: "https://api.platform.example.com/...&next_token=..." } }
```

`nextPage`の`next_token`を、次の呼び出しの`next_token`へ渡します。

結果は`SearchPersonResult`で、`linkedinProfileUrl`とprofileを含めます。get_profileで追加情報を取得できます（通常2クレジット、30日キャッシュ）。同じ相手の再取得はキャッシュを使います。

<span id="5-save-leads-to-your-crm"></span>

### 5. CRMへの保存

LinkedIn URLとプロフィールをアプリのDBへ保存します。スキーマの例：

```sql
CREATE TABLE lead_lists (
  id            uuid PRIMARY KEY,
  owner_id      uuid NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_list_members (
  id              uuid PRIMARY KEY,
  list_id         uuid NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  linkedin_url    text NOT NULL,
  full_name       text,
  headline        text,
  email           text,                                   -- populated after email lookup resolves
  email_status    text DEFAULT 'unknown',                 -- 'unknown' | 'pending' | 'found' | 'not_found'
  enriched_at     timestamptz,
  UNIQUE (list_id, linkedin_url)
);
```

manage_schemaで適用します。

<span id="6-enrich-on-demand"></span>

### 6. 必要に応じた情報補完

詳細画面でget_profileを呼びます。初回は通常2クレジット、30日以内は無料です。

```jsonc
{
  "action": "get_profile",
  "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123"
}
// → { data: { fullName: "Jane Doe", headline: "VP at InwestCo", ... },
//     usage: { cached: false, usdCharged: 0.040 } }
```

`usage.cached`でキャッシュの利用を確認できます。

<span id="7-look-up-work-email-async"></span>

### 7. 非同期の勤務先メール検索

キューへ追加し、プロバイダーのWebhookを待ちます。

```jsonc
{
  "action": "queue_email_lookup",
  "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123"
}
// → { lookupId: "0e9796cf-...", status: "pending", usage: { creditsConsumed: 3 } }
```

UIに「メールを検索中…」を表示します。

確定するまで確認します。

```jsonc
{ "action": "get_email_lookup", "id": "0e9796cf-..." }
// pending → { status: "pending", email: null, credits_consumed: 0 }
// resolved → { status: "resolved", email: "jane.doe@inwestco.com", credits_consumed: 1 }
// failed → { status: "failed", email: null, credits_consumed: 0 }  (email not found)
```

`people_email_lookups`の変更をリアルタイムAPIで購読する方法もあります。

通常は**数秒から数分**かかります。

<span id="pricing-summary"></span>

## 料金の概要

接続先により異なります。[人物検索API](/ja/api-reference/people-api/#pricing)で目安を確認し、実際の料金は`x-people-*`とusageを使ってください。

呼び出しをpeople_usage_logsへ記録します。select_rowsで分析できます。

<span id="limits--gotchas"></span>

## 制約と注意点

- **残高不足は402**。既定の最低額は0.05米ドルで、Billingページから補充します。
- **page_sizeの上限は100**。
- **キャッシュはアプリ単位**。同じURLでも別アプリの初回は課金します。
- **URLを正規化**してキャッシュのキーにします。大文字、小文字、クエリ、末尾のスラッシュの差を除きます。
- **プロフィールには更新の遅れ**があります。転職などの反映に数週間かかる場合があります。
- **現在の職はexperiences[0]だけで判断しない**。古い職歴が先頭にある場合があるため、occupationやheadlineを優先します。
- **電話番号は非対応**。
- **メールが見つからない場合**があります。元ページの目安では20〜40%がfailedです。その場合、結果確定分のクレジットは課金しません。

<span id="see-also"></span>

## 関連ページ

- [人物検索API](/ja/api-reference/people-api/)：RESTの仕様。
- [manage_people](/ja/api-reference/mcp-tools/#people-people--company-search--enrichment)：MCPツール。
- [AIゲートウェイ](/ja/api-reference/ai-api/)：自然言語から条件への変換。
- [リアルタイムAPI](/ja/api-reference/data-api/)：メール確定の配信。
