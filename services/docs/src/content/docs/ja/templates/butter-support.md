---
title: Butter Support
description: 埋め込みウィジェット、文書検索、承認付きのAI返信を備えるサポート窓口を複製します。
---

**アプリID：** `app_0ycj4ad7odud` · **リージョン：** `us-east-1` · **30関数とDurable Object** · **複製19件**（元ページ掲載時点）

AIを使うサポート窓口です。ウィジェットの質問を文書のRAGで検索し、自律性の設定に応じて承認用の下書きや自動解決を行います。対応例をポリシーへ反映し、運用しながら改善できます。

:::danger
**複製直後は最も高い自律性です。** 既定の`AUTO-RESOLVE`では人の承認なしで返信・終了します。`account_deletion`、`billing`、`cancellation`だけが`ALWAYS ESCALATE`です。実際の顧客へ公開する前に手順5を確認してください。
:::

[RAG](/ja/core-concepts/rag/)、[Durable Objects](/ja/core-concepts/durable-objects/)、[Substrate](/ja/core-concepts/substrate/)の連携を試せます。[CRM](/ja/templates/butterbase-crm/)より設定が必要で、関数とDurable Objectの環境変数を以下で確認します。

![複製直後のAutonomy設定。既定値はAUTO-RESOLVE](/img/templates/support-overview.png)

<span id="whats-in-it"></span>

## 含まれる機能

<span id="the-embeddable-widget"></span>

### 埋め込みウィジェット
`widget-ingest` · `widget-followup` · `widget-fetch-history` · `rotate-widget-secret`

サイトへ埋め込み、質問、同じ会話の追加質問、履歴取得を行います。ウィジェットのシークレットは再デプロイせず更新できます。

<span id="docs-ingestion-and-rag"></span>

### 文書の取り込みとRAG
`ingest-docs` · `refresh-docs` *(cron)* · `delete-docs-source` · `request-doc-upload-url` · `ai-rag-query`

文書のURLや署名付きURLのファイルを取り込み、チャンクと埋め込みへ変換します。`refresh-docs`が定期的に再取得します。

<span id="ai-answering"></span>

### AI回答
`ai-chat-completion` · `ask-support-overview`

チケットの文脈に基づく回答と、「今週の問い合わせで多い問題は何か」などの全体分析。

<span id="agent-proposals-with-human-approval"></span>

### 人の承認を待つ提案
`do-substrate-propose` · `approve-proposal` · `reject-proposal` · `expire-agent-proposals` *(cron)* · `admin-autonomy`

承認が必要な設定では、エージェントが提案し、人が承認・拒否します。古い提案は失効します。`admin-autonomy`が自律性を制御します。

<span id="replies-and-escalation"></span>

### 返信と引き継ぎ
`auto-reply-worker` · `send-draft-reply` · `execute-escalation`

承認した下書きを送信し、対応できない問題を設定済みの経路へ引き継ぎます。

<span id="learning-from-what-humans-did"></span>

### 対応からの学習
`convert-to-policy` · `mark-as-commitment` · `sweep-pattern-signals` *(cron)*

良い対応例を再利用するポリシーへ反映し、顧客への約束も追跡します。cronで繰り返し現れるパターンを探します。

<span id="substrate-team-and-ops"></span>

### Substrate、チーム、運用
`substrate-proxy` · `substrate-read-internal` · `sync-ticket-artifact` · `auth-bootstrap-hook` · `invite-teammate` · `remove-teammate` · `fetch-ai-usage` · `cleanup-idempotency-keys` *(cron)*

<span id="cloning-it"></span>

## 複製方法

<span id="dashboard"></span>

### ダッシュボード

1. [ダッシュボード](https://dashboard.butterbase.ai)の**Templates**を開きます。
2. **butter-support**の**Clone**を選びます。
3. 名前を設定します。リージョンは元と同じ`us-east-1`です。
4. `SUBSTRATE_OUTBOX_SECRET`と`RAG_COLLECTION`を入力します。空欄のまま、後から関数エディターで設定することもできます。
5. **Start clone**を選びます。

![SUBSTRATE_OUTBOX_SECRETとRAG_COLLECTIONを入力する複製画面](/img/templates/support-clone-env-step.png)

### CLI

```bash
butterbase clone app_0ycj4ad7odud ./my-support --name "My Support Desk"
```

### MCP

必要な2つのキーを指定すると、関数を設定した状態で開始できます。

```
manage_app action: "clone"
  source_app_id: "app_0ycj4ad7odud"
  name: "My Support Desk"
  env_var_values: {
    "auto-reply-worker":  { "SUBSTRATE_OUTBOX_SECRET": "<generate a strong secret>" },
    "execute-escalation": { "SUBSTRATE_OUTBOX_SECRET": "<same secret>" },
    "refresh-docs":       { "RAG_COLLECTION": "support-docs" },
    "ingest-docs":        { "RAG_COLLECTION": "support-docs" },
    "delete-docs-source": { "RAG_COLLECTION": "support-docs" }
  }
```

応答の`pending_env_vars`で不足する値を確認してください。

<span id="setting-it-up-after-the-clone"></span>

## 複製後の設定

<span id="1-fill-the-two-required-function-keys"></span>

### 1. 関数の2つのキーを設定

自動設定されないのは次の2つです。

| キー | 関数 | 設定する値 |
|---|---|---|
| `SUBSTRATE_OUTBOX_SECRET` | `auto-reply-worker`, `execute-escalation` | 自分で生成した強いランダムなシークレット。**両関数で同じ値**を使います。 |
| `RAG_COLLECTION` | `refresh-docs`, `ingest-docs`, `delete-docs-source` | 手順3で作成するコレクション名。**3関数で完全に一致**させます。 |

```
manage_function action: "update_env"
  app_id: "<your_app_id>"
  function_name: "auto-reply-worker"
  env: { "SUBSTRATE_OUTBOX_SECRET": "..." }
```

:::caution
3関数の`RAG_COLLECTION`が異なると、保存先と検索先が食い違い、回答の検索結果が空になる原因になります。
:::

<span id="2-re-set-the-durable-object-environment"></span>

### 2. Durable Objectの環境変数を再設定

元ページで確認した複製では、7つのうち4つが設定済みで、3つが不足していました。実際の`list_env`を確認してください。

| キー | 複製後 | 設定する値 |
|---|---|---|
| `BUTTERBASE_API_KEY` | ✅ あり | — |
| `DEFAULT_MODEL` | ✅ あり | モデルを確認 |
| `HAIKU_MODEL` | ✅ あり | モデルを確認 |
| `SUBSTRATE_OUTBOX_SECRET` | ✅ あり | — |
| `BUTTERBASE_API_URL` | ❌ **なし** | Control APIのURL（例：`https://api.butterbase.ai`） |
| `BUTTERBASE_APP_ID` | ❌ **なし** | 新しいアプリID |
| `RAG_COLLECTION` | ❌ **なし** | 手順1と同じコレクション名 |

不足する3つは、元の値をそのまま使えない項目です。2つは元アプリを指し、1つは未作成のRAGコレクション名です。

:::caution
複製画面の`RAG_COLLECTION`は**関数**に設定します。Durable Objectには別途、同じ値を設定してください。元ページの実測でも、関数には設定され、DOの`list_env`にはありませんでした。

事前確認の`preview_clone_env_vars`と複製後の値が異なる場合があります。元ページでは`DEFAULT_MODEL`、`HAIKU_MODEL`、`SUBSTRATE_OUTBOX_SECRET`は実際には引き継がれました。完了後の`list_env`で確認してください。
:::

設定する前に現在の値を確認します。

```
manage_durable_objects action: "list_env", app_id: "<your_app_id>"
```

1回で1キーを設定します。DOの環境変数はアプリ全体で共有するため、クラスの`name`は不要です。

```
manage_durable_objects action: "set_env"
  app_id: "<your_app_id>"
  key: "BUTTERBASE_APP_ID"
  value: "<your_app_id>"
```

更新すると有効なクラスを自動で再デプロイします。`list_env`で確認してください。

:::caution
モデルIDは一覧で確認し、プロバイダー付きの完全な値を指定します。`claude-sonnet-4-5`だけでは呼び出せません。`manage_ai action: "list_models"`からコピーしてください。
:::

![複製直後のDurable Object環境変数。7つ中4つが設定済み](/img/templates/support-do-env.png)

<span id="3-create-the-rag-collection-and-ingest-your-docs"></span>

### 3. RAGコレクションと文書を用意

```
manage_rag_content action: "create_collection"
  app_id: "<your_app_id>"
  name: "support-docs"
```

名前は手順1・2の`RAG_COLLECTION`と一致させます。`ingest-docs`へURLを指定するか、`request-doc-upload-url`でファイルを送信します。[RAG](/ja/core-concepts/rag/)を参照してください。

文書がないとモデルの一般知識で回答し、自分の文書を参照した回答にはなりません。

<span id="4-rebind-the-auth-hook-if-a-warning-said-so"></span>

### 4. 警告があれば認証フックを再設定

ログイン後の`auth-bootstrap-hook`を紐付けられなかった場合、警告に表示します。

```
manage_auth_config action: "configure_auth_hook"
  app_id: "<your_app_id>"
  post_auth_function: "auth-bootstrap-hook"
```

<span id="5-set-the-autonomy-level-deliberately"></span>

### 5. 自律性を明示的に選択

**Console → Autonomy**で設定します。複製直後の動作を確認してください。

| 設定 | 複製直後の値 |
|---|---|
| **既定モード** | `AUTO-RESOLVE`。人の承認なしで返信し、解決したと判断すれば終了。 |
| **問題ごとの上書き** | `account_deletion`、`billing`、`cancellation`は`ALWAYS ESCALATE`。自動返信せず引き継ぎ。 |

問題ごとに**Draft for approval**も選択できます。下書きを人が承認する設定ですが、既定値ではありません。

公開前に次のいずれかを選びます。

- まず**Draft for approval**で返信を確認し、必要に応じて自律性を上げる。
- AUTO-RESOLVEを維持し、誤回答の影響が大きいすべての種類を上書きする。

上書きは分類結果の`issue_type`に対応します。未登録の種類は既定モードになるため、指定した種類だけが対象です。

<span id="6-rotate-the-widget-secret"></span>

### 6. ウィジェットのシークレットを更新

```
invoke_function app_id: "<your_app_id>", function_name: "rotate-widget-secret"
```

公開する前に更新し、元アプリ由来の値のまま使わないでください。

<span id="7-point-cors-at-the-sites-hosting-the-widget"></span>

### 7. ウィジェットを置くサイトのCORS

```
manage_app action: "update_cors"
  app_id: "<your_app_id>"
  allowed_origins: ["https://mysite.com", "https://docs.mysite.com"]
```

別オリジンから接続するため、CORSが合わないと読み込みに失敗します。

<span id="8-check-the-frontend"></span>

### 8. フロントエンドの確認

新しいアプリへ接続するSupportフロントエンドが公開されます。読み込みを確認し、編集する場合はローカルへ取得してください。

```bash
butterbase repo init <your_app_id>
butterbase repo pull
```

[フロントエンドのデプロイ](/ja/core-concepts/frontend-deployment/)で再デプロイします。

<span id="verifying-it-works"></span>

## 動作確認

1. `manage_durable_objects action: "list_env"`で7つのキーを確認。
2. コレクション一覧で文書の存在を確認。
3. `ai-rag-query`へ文書で答えられる質問を送り、引用があることを確認。
4. ウィジェットから質問してInboxを確認。**初期のInboxは空**で、初期チケットは複製しません。
5. 承認して返信を確認。

<span id="cost-note"></span>

## 費用

取り込みの埋め込み、定期的な文書更新、質問ごとのAI呼び出しで費用が発生します。[支出上限](/ja/core-concepts/plans-and-usage/#credits-top-ups-and-spending-caps)と`HAIKU_MODEL`を確認してから公開してください。
