# 認証とMCPクライアント

[導入ガイド](../../../SETUP.ja.md) · [前：データベース](./database.md) · [次：開発](./development.md)

## 認証を有効にする

既定のローカル構成は `AUTH_ENABLED=false` です。`/init` と `/apps` はトークンなしで使えます。この状態でポート4000をインターネットへ公開しないでください。

セルフホストやステージングでは、`docker-compose.local.yml` のControl APIの `environment` にある `AUTH_ENABLED: "false"` を次の値へ変更します。

```yaml
AUTH_ENABLED: "true"
```

変更後に `docker compose -f docker-compose.local.yml up -d control-api` でコンテナを再作成します。`.env` は `AUTH_ENABLED=true` のような `KEY=value` 形式ですが、Composeの明示的な `environment` の値が優先されます。このComposeで `.env` だけを変更しても、既定の `false` は上書きされません。

Cognitoを使うダッシュボード認証では、`COGNITO_USER_POOL_ID`、`COGNITO_CLIENT_ID`、`COGNITO_REGION` も必要です。マネージド版のダッシュボードはOSSに含まれていないため、APIキーまたは自分のフロントエンドを使います。

## APIキーを使う

1. 認証を有効にし、IdPの処理などでプラットフォームユーザーを用意します。必要に応じて `platform_users` に登録します。
2. 有効なJWTまたは管理用経路を使い、ダッシュボードAPIや管理ルートからキーを作ります。
3. APIへBearerトークンとして渡します。

```bash
export BUTTERBASE_API_KEY="bb_sk_..."
curl http://localhost:4000/apps \
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
```

## HTTPのMCPを接続する

Control APIが起動している場合はHTTPを推奨します。MCPクライアントは `application/json` と `text/event-stream` の両方を受け付ける必要があります。Cursorの設定例です。

```json
{
  "mcpServers": {
    "butterbase": {
      "url": "http://localhost:4000/mcp",
      "headers": {
        "Authorization": "Bearer ${env:BUTTERBASE_MCP_TOKEN}"
      }
    }
  }
}
```

```bash
export BUTTERBASE_MCP_TOKEN="bb_sk_..."
```

このトークンは `AUTH_ENABLED=true` の場合に必要です。

## stdioのMCPを接続する

貢献者がローカルでビルドしたMCPサーバーを使う場合は、出力されたエントリーポイントを指定します。

```bash
npm run build --workspace=services/mcp-server
```

```json
{
  "mcpServers": {
    "butterbase": {
      "command": "node",
      "args": ["./services/mcp-server/dist/index.js"],
      "env": {
        "BUTTERBASE_API_URL": "http://localhost:4000",
        "BUTTERBASE_API_KEY": "bb_sk_..."
      }
    }
  }
}
```

環境変数の扱いはMCPクライアントによって異なります。`services/mcp-server` の文書も確認してください。例の `bb_sk_...` はプレースホルダーです。実際のキーをコミットしないでください。
