---
title: CLI
description: プロジェクト作成とバックエンド管理のコマンドラインツールです。
---

`@butterbase/cli`でアプリ、スキーマ、関数、ストレージ、デプロイを管理できます。

<span id="installation"></span>

## インストール

```bash
npm install -g @butterbase/cli
```

<span id="quick-start"></span>

## クイックスタート

```bash
# Login with your API key
butterbase login

# Create a new app
butterbase apps create my-app

# Set as current app
butterbase apps use app_abc123

# Get current schema
butterbase schema get --output schema.json

# Apply schema changes
butterbase schema apply schema.json

# Deploy a function
butterbase functions deploy ./functions/hello.ts

# Upload a file
butterbase storage upload ./image.png
```

<span id="project-init"></span>

## プロジェクトの初期化

```bash
# Scaffold a new project (prompts for name, template, optional app ID)
butterbase init

# Specify the template directly
butterbase init react-vite
```

対応するテンプレートは`react-vite`です。ファイルを作成し、`.env.example`があれば`.env`へコピーします。`cd`、`npm install`、`npm run dev`と、MCP・エージェントの設定方法を表示します。

<span id="authentication"></span>

## 認証

```bash
butterbase login
butterbase logout
```

<span id="configuration"></span>

## 設定

```bash
# Show current config
butterbase config get

# Set endpoint
butterbase config set endpoint https://api.butterbase.ai

# Set API key
butterbase config set apiKey bb_sk_...
```

設定は`~/.butterbase/config.json`へ保存します。プロジェクトの`.butterbase/config.json`を優先します。

<span id="apps"></span>

## アプリ

```bash
butterbase apps list
butterbase apps create my-app
butterbase apps use app_abc123
butterbase apps delete app_abc123
```

作成時のリージョン指定と移動には、[MCP](/ja/getting-started/mcp-setup/)（`init_app`、`list_regions`、`manage_app`の`move`・`move_status`）や[REST API](/ja/api-reference/platform-api/#apps--regions)を使えます。[リージョン](/ja/core-concepts/regions/)を参照してください。

<span id="schema"></span>

## スキーマ

```bash
# Get current schema
butterbase schema get

# Save to file
butterbase schema get --output schema.json

# Preview changes (dry-run)
butterbase schema apply schema.json --dry-run

# Apply changes
butterbase schema apply schema.json

# Apply with custom migration name
butterbase schema apply schema.json --name "add_users_table"

# Use specific app
butterbase schema get --app app_abc123
```

<span id="functions"></span>

## 関数

```bash
# List deployed functions (also prints trigger types and 🤖 marker if exposed as agent tool)
butterbase functions list

# Deploy function
butterbase functions deploy ./functions/hello.ts

# Deploy with custom name
butterbase functions deploy ./functions/hello.ts --name my-function

# Deploy cron function
butterbase functions deploy ./functions/cleanup.ts \
  --trigger cron \
  --trigger-config '{"schedule":"*/5 * * * *"}'

# Expose a function to agents as a tool
butterbase functions deploy ./functions/lookup_account.ts \
  --agent-tool \
  --agent-tool-description "Look up a customer by email." \
  --agent-tool-mode read_only \
  --agent-tool-exposed-to developer_only

# View logs
butterbase functions logs my-function

# Error logs only
butterbase functions logs my-function --level error

# Limit log count
butterbase functions logs my-function --limit 50
```

ログは日時、メソッド、ステータス、所要時間、エラーを表示します。`console.log/info/warn/error/debug`の出力は各ログの下に字下げして表示します。

**トリガー：** `http`（既定）、`cron`、`s3_upload`、`webhook`、`websocket`。複数トリガーはダッシュボードまたはRESTの`triggers: [...]`で指定します。CLIの`--trigger`は単一の指定です。

**ツールの設定：** `--agent-tool-mode`は`read_only`（既定、承認不要）または`read_write`（毎回人の承認を待つ）。`--agent-tool-exposed-to`は`developer_only`（既定）または`end_user`です。

<span id="agents"></span>

## エージェント

```bash
# List agents
butterbase agents list

# Show one agent
butterbase agents get my-agent

# Create an agent from a graph_spec.json file
butterbase agents create \
  --name my-agent \
  --display-name "My agent" \
  --default-model anthropic/claude-3.5-sonnet \
  --spec ./agent-spec.json

# Update fields (status, default_model, graph_spec)
butterbase agents update my-agent --status disabled
butterbase agents update my-agent --spec ./agent-spec.json

# Delete an agent
butterbase agents delete my-agent
```

グラフ仕様は[エージェント](/ja/core-concepts/agents/)、一連の手順は[エージェントのクイックスタート](/ja/getting-started/agents-quickstart/)を参照してください。

<span id="storage"></span>

## ストレージ

```bash
butterbase storage list
butterbase storage upload ./image.png
butterbase storage delete obj_abc123
```

<span id="realtime"></span>

## リアルタイム

```bash
# Enable realtime broadcasts on one or more tables
butterbase realtime enable posts comments

# Show realtime configuration (URL, active connection, table list)
butterbase realtime config
butterbase realtime config --json

# Disable realtime on a single table
butterbase realtime disable posts
```

<span id="frontend-env-vars"></span>

## フロントエンドの環境変数

これらはフロントエンドのビルドへ埋め込む値です。関数用は上の関数の節と[関数の概念](/ja/core-concepts/functions)を参照してください。

```bash
# Set one or more KEY=VALUE pairs
butterbase env set VITE_API_URL=https://api.example.com DEBUG=true

# List current keys (values are not shown)
butterbase env list
butterbase env list --json

# Load from a .env file
butterbase env set-file .env.production
```

<span id="api-keys"></span>

## APIキー

```bash
# Generate a new key (shown once)
butterbase keys generate "deploy-bot"

# List keys (key prefix only — full values are not retrievable)
butterbase keys list

# Revoke a key (prompts for confirmation)
butterbase keys revoke key_abc123
```

<span id="integrations"></span>

## 外部サービスとの連携

Gmail、Slack、GitHubなどを管理します。[外部サービスとの連携](/ja/core-concepts/integrations)を参照してください。

```bash
# List the curated catalog (or search the full catalog)
butterbase integrations list
butterbase integrations list --search salesforce

# Show toolkits configured for the current app
butterbase integrations config

# Enable a toolkit for the app
butterbase integrations configure gmail
butterbase integrations configure slack --display-name "Workspace bot"

# Disable a toolkit
butterbase integrations disable slack

# Generate an OAuth URL for an end-user to connect their account
butterbase integrations connect gmail \
  --redirect-url https://app.example.com/integrations/callback

# List all end-user connections
butterbase integrations connections

# Disconnect a single user's account
butterbase integrations disconnect ca_xxx

# List tools available for a connected toolkit
butterbase integrations tools gmail

# Execute a tool (e.g., as a smoke test)
butterbase integrations execute GMAIL_SEND_EMAIL \
  --data '{"to":"user@example.com","subject":"hi","body":"hello"}'
```

多くのサブコマンドでは`--app <app-id>`で対象を指定でき、ユーザーの代理実行時は`--user-id <uuid>`を使います。

<span id="custom-domains"></span>

## カスタムドメイン

フロントエンドの独自ドメインを管理します。Launch以上が必要です。[カスタムドメイン](/ja/core-concepts/custom-domains/)を参照してください。

```bash
# List domains for the current app
butterbase domains list

# Add a new custom hostname (returns the CNAME target + setup instructions)
butterbase domains add app.example.com

# Poll verification status
butterbase domains status dom_abc123

# Re-trigger verification after fixing DNS
butterbase domains verify dom_abc123

# Remove a domain (prompts; pass --yes to skip)
butterbase domains delete dom_abc123 --yes
```

<span id="plugin"></span>

## プラグイン

```bash
# Set up Claude Code / MCP integration for this project
butterbase plugin setup
```

現在のディレクトリへMCP接続用の`.mcp.json`を作成します。既存ファイルがある場合は上書きしません。

ガイド付きのButterbase Skillsは別途インストールします。

```bash
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills
claude plugin install butterbase-skills@butterbase-skills
```

<span id="data"></span>

## データ

```bash
butterbase data list             # List tables
butterbase data query posts      # Query rows from a table
```

<span id="deployments"></span>

## デプロイ

```bash
butterbase deploy ./dist         # Deploy frontend from a directory
```

<span id="project-status"></span>

## プロジェクトの状態

```bash
# Print app summary: name, region, tables, deployments, env keys, functions, CORS
butterbase status
butterbase status --json
```

<span id="open-in-browser"></span>

## ブラウザーで開く

```bash
# Open the live frontend URL
butterbase open

# Open the API base URL instead
butterbase open --api
```

有効なデプロイがなければ、`butterbase open`はエラーで終了します。

<span id="global-options"></span>

## グローバルオプション

多くのコマンドは`--app`で対象を指定できます。

```bash
butterbase schema get --app app_abc123
butterbase functions list --app app_abc123
butterbase storage list --app app_abc123
```

省略すると、`butterbase apps use`で選択したアプリを使います。

## KV

```bash
# Get a value
butterbase kv get mykey

# Set a value with optional TTL
butterbase kv set mykey '{"a":1}' --ttl 3600

# Delete a key
butterbase kv del mykey

# List keys by prefix
butterbase kv ls --prefix user: --limit 50

# Show KV store statistics
butterbase kv stats

# Flush all keys (requires confirmation)
butterbase kv flush --confirm

# List all exposure rules
butterbase kv rules

# Expose a key pattern with role-based access
butterbase kv expose "user:*" --read authed --write owner

# Unexpose a key pattern
butterbase kv unexpose "user:*"

# Apply exposure rules from a config file
butterbase kv apply ./kv.config.ts --dry-run
```

<span id="common-kv-workflows"></span>

### KVのよくある操作

**設定ファイルから公開ルールを反映：**

```bash
# kv.config.ts in your project root, then:
butterbase kv apply kv.config.ts
```

フロントエンドからアクセスできるキーパターンを宣言します。現在のルールとの差分だけを適用するため、繰り返し実行できます。

**本番のキーを確認：**

```bash
butterbase kv ls --prefix session:
# 142 keys under session:*

butterbase kv stats
# {
#   "keys_total": 1284,
#   "bytes_used": 2202112,
#   "max_keys": 100000,
#   "max_storage_bytes": 104857600,
#   "max_ops_per_sec": 500,
#   "max_value_bytes": 65536
# }
```

**調査時に1件のキーを読み書き：**

```bash
butterbase kv get rate-limit:user_42        # peek a counter
butterbase kv set feature:new-checkout off  # flip a flag without redeploying
```

<span id="environment-variables"></span>

## 環境変数

CLIはAPIキーとエンドポイントを設定ファイルから読み取ります。`butterbase config set` で設定してください。

`BUTTERBASE_API_KEY` は、`butterbase plugin setup` と `butterbase mcp install` が生成するMCPクライアント設定で使います。`butterbase integrations configure` と `rotate` は、連携先の `<TOOLKIT>_CLIENT_ID` と `<TOOLKIT>_CLIENT_SECRET` を環境変数から読み取ることもできます。
