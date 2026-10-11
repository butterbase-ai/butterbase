---
title: Butterbase CRM
description: 連絡先、商談、Google同期、会議メモ、キャンペーン、SNS投稿を備えるAI CRMを複製します。
---

**アプリID：** `app_44zjayftl7b3` · **リージョン：** `us-east-1` · **56関数** · **複製33件**（元ページ掲載時点）

AIを組み込んだCRMです。連絡先と企業の情報補完、GmailとCalendarの定期同期、会議の録画と要約、活動に基づく商談提案、キャンペーン、SNS投稿に対応します。

テンプレート一覧で最大の構成です。起動に必要な環境変数は複製時に自動で設定されるため、起動前に外部APIキーを取得する必要はありません。

![初期データを含む、複製直後のButterbase CRMの企業画面](/img/templates/crm-overview.png)

<span id="whats-in-it"></span>

## 含まれる機能

<span id="contacts-companies-and-enrichment"></span>

### 連絡先、企業、情報補完
`enrich-person` · `enrich-company` · `summarize-company` · `find-duplicates` · `trigger-enrichment` · `crm-record-activity`

公開情報でレコードを補完し、連絡先の重複を検出します。企業にはAIの要約を作成します。

<span id="google-sync"></span>

### Googleとの同期
`ingest-gmail` · `ingest-calendar` · `auto-sync-google` *(cron)* · `upsert-sync-settings`

メールとカレンダーを定期的に活動の履歴へ取り込みます。ユーザーごとの設定で対象を指定します。

<span id="meetings-and-notetaking"></span>

### 会議と議事録
`start-meeting-bot` · `cancel-meeting-bot` · `notetaker-webhook` · `ingest-meeting-transcript` · `get-meeting-notes` · `crm-upsert-meeting` · `migrate-meetings-to-substrate`

ボットが会議に参加して文字起こしを行い、構造化したメモを保存します。Webhookのシークレットは複製時に発行します。

### AI
`agent-chat` · `ai-search` · `ai-suggest-filters`

CRMへの自然言語のチャット、レコードの意味検索、AIによる一覧の絞り込み。

<span id="deals"></span>

### 商談
`propose-deals` · `accept-deal-proposal` · `agent-proposals-expire` *(cron)*

活動を見たエージェントが商談を提案し、人が承認します。未承認の提案は定期的に失効します。

<span id="lead-generation"></span>

### 見込み客の獲得
`lead-search` · `lead-save` · `lead-cost-preview` · `list-lead-lists`

見込み客を検索し、クレジットの費用を確認して一覧へ保存します。

<span id="campaigns"></span>

### キャンペーン
`create-campaign-list` · `start-campaign` · `pause-campaign` · `process-campaign-sends` *(cron)* · `resolve-pending-emails` *(cron)* · `reply-to-inbox-item`

対象の一覧と送信の順序を作成し、cronで送信と返信の処理を行います。

<span id="social-publishing"></span>

### SNS投稿
`create-social-post` · `edit-social-post` · `clone-social-post` · `publish-social-post` · `send-social-post` · `delete-social-post-from-platform` · `process-scheduled-social-posts` *(cron)* · `comment-on-social-post` · `discover-comment-targets` · `run-comment-discovery` *(cron)* · `execute-comment-campaign` · `fetch-post-replies` *(cron)* · `get-subreddit-flairs` · `configure-social-toolkit`

複数のサービスへの下書き、予約、投稿と、対象を検索して定期的にコメントするキャンペーン。

<span id="integrations-team-and-substrate"></span>

### 外部連携、チーム、Substrate
`register-integration` · `unregister-integration` · `list-workspace-integrations` · `cleanup-orphan-integrations` *(cron)* · `invite-member` · `accept-invite` · `check-allowlist` · `substrate-proxy` · `list-substrate-entities`

<span id="cloning-it"></span>

## 複製方法

<span id="dashboard"></span>

### ダッシュボード

1. [ダッシュボード](https://dashboard.butterbase.ai)の**Templates**を開きます。
2. **butterbase-crm**の**Clone**を選びます。
3. 名前を設定します。ダッシュボードではリージョンは元と同じ`us-east-1`です。
4. 環境変数は自動設定されるため、**Nothing to enter**のまま進みます。
5. **Start clone**を選び、56関数の再デプロイを数分待ちます。

![環境変数はプラットフォームが設定するため、入力不要と表示する複製画面](/img/templates/crm-clone-modal.png)

### CLI

```bash
butterbase clone app_44zjayftl7b3 ./my-crm --name "My CRM" --region us-east-1
```

### MCP

```
manage_app action: "clone"
  source_app_id: "app_44zjayftl7b3"
  name: "My CRM"
  region: "us-east-1"
```

次に状態を確認します。

```
manage_app action: "get_clone_job", job_id: "<job_id>"
```

### REST

```json
POST /v1/templates/app_44zjayftl7b3/clone
{ "name": "My CRM", "region": "us-east-1" }
```

<span id="setting-it-up-after-the-clone"></span>

## 複製後の設定

<span id="1-read-the-clone-warnings"></span>

### 1. 警告を読む

```
manage_app action: "get_clone_job", job_id: "<job_id>"
```

会議のWebhookを再設定した場合、警告に新しい`wsec_*`を1回だけ表示します。`notetaker-webhook`には設定済みですが、自分でも安全に保存してください。

<span id="2-confirm-the-auto-filled-keys-landed"></span>

### 2. 自動設定したキーを確認

このテンプレートは、プラットフォームで扱う次のキーを使います。

| キー | 使用先 | 設定する値 |
|---|---|---|
| `BUTTERBASE_API_KEY` | 27関数 | 新しいアプリ専用の`bb_sk_*` |
| `BUTTERBASE_API_URL` | `ai-suggest-filters`、`lead-search`、`lead-save` | Control APIのURL |
| `BUTTERBASE_APP_ID` | `ai-suggest-filters`、`lead-search`、`lead-save`、`configure-social-toolkit` | 新しいアプリID |
| `NOTETAKER_WEBHOOK_SECRET` | `notetaker-webhook` | 発行した`wsec_*` |
| `BB_SUBSTRATE_KEY` | `substrate-proxy` | 発行した`bb_sk_*`（元テンプレートの表記） |

1つの関数で確認します。

```
manage_function action: "get", app_id: "<your_app_id>", function_name: "agent-chat"
```

<span id="3-add-google-oauth-credentials"></span>

### 3. Google OAuthの認証情報を設定

GmailとCalendarには自分のGoogleクライアントIDとシークレットが必要です。元のアプリの値は複製しません。

```
manage_oauth action: "configure"
  app_id: "<your_app_id>"
  provider: "google"
  client_id: "..."
  client_secret: "..."
  redirect_uris: ["https://api.butterbase.ai/auth/<your_app_id>/oauth/google/callback"]
```

Google側でGmailとCalendarのスコープを有効にします。未設定でも取り込み関数は動きますが、データは取得しません。

<span id="4-connect-the-integrations-you-actually-want"></span>

### 4. 使用する連携を接続

SNS投稿とコメントは[外部連携](/ja/core-concepts/integrations/)を使います。利用するサービスだけを登録してください。

```
manage_integrations action: "list_available"   # what you can connect
manage_integrations action: "list_connected"   # what this app already has
```

未接続の場合、`process-scheduled-social-posts`、`run-comment-discovery`、`fetch-post-replies`は処理せず終了します。

<span id="5-decide-about-the-meetings-notetaker"></span>

### 5. 会議ボットの利用を判断

`start-meeting-bot`は実際に会議へボットを送ります。参加者の同意と、自分や参加者に適用される録画の規則を確認してから使ってください。

<span id="6-point-cors-at-your-frontend"></span>

### 6. フロントエンドのCORSを設定

```
manage_app action: "update_cors"
  app_id: "<your_app_id>"
  allowed_origins: ["https://mycrm.com", "http://localhost:5173"]
```

<span id="7-check-the-frontend"></span>

### 7. フロントエンドを確認

CRMのフロントエンドは、新しいアプリへ接続する形で公開されます。概要画面のURLを開き、読み込めることを確認してください。

編集する場合はローカルへ取得します。

```bash
butterbase repo init <your_app_id>
butterbase repo pull
cd <dir> && npm install && npm run build
```

変更後は[フロントエンドのデプロイ](/ja/core-concepts/frontend-deployment/)に従って再デプロイします。`VITE_*`は関数の環境変数とは別で、継承しません。

<span id="8-review-the-security-posture"></span>

### 8. アクセス設定を確認

関数が多いため、実データを投入する前に確認してください。

- `manage_app action: "get_config"`でアクセスモードを確認。
- 複製した[RLSポリシー](/ja/core-concepts/row-level-security/)を確認。
- 公開されるHTTP関数と、利用しない機能の制限を確認。

<span id="verifying-it-works"></span>

## 動作確認

1. `manage_schema action: "get"`でスキーマを確認。
2. `ai-search`を`invoke_function`で実行。500なら環境変数を確認。
3. テストユーザーを登録。
4. Googleアカウントを接続して`ingest-gmail`を実行。
5. フロントエンドの連絡先画面を確認。

<span id="cost-note"></span>

## 費用

情報補完、要約、チャット、検索がAIクレジットを消費し、cronも自動で動きます。継続運用する前に[支出上限](/ja/core-concepts/plans-and-usage/#credits-top-ups-and-spending-caps)を設定してください。
