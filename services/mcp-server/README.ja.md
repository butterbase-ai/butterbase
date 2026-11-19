# @butterbase/mcp

[English](README.md) | 日本語

[Butterbase](https://butterbase.ai)の公式[Model Context Protocol](https://modelcontextprotocol.io)サーバーです。Claude Code・Claude Desktop・Cursor・Windsurfなどから、スキーマ・認証・関数・ストレージ・RAG・realtime・配置を操作します。

## インストール

```bash
npx @butterbase/mcp
```

グローバルへインストールする場合です。

```bash
npm install -g @butterbase/mcp
butterbase-mcp
```

## 設定

MCPクライアントの`.mcp.json`や`claude_desktop_config.json`へ追加します。例のキーはプレースホルダーです。[Butterbase](https://butterbase.ai)で取得した自分の値へ置き換え、公開リポジトリへ保存しないでください。

```json
{
  "mcpServers": {
    "butterbase": {
      "command": "npx",
      "args": ["-y", "@butterbase/mcp"],
      "env": {
        "BUTTERBASE_API_KEY": "bb_sk_your_key_here"
      }
    }
  }
}
```

## ホスト型の接続

ローカルインストールの代わりに、ホスト型のMCPエンドポイントも使えます。

```json
{
  "mcpServers": {
    "butterbase": {
      "url": "https://api.butterbase.ai/mcp",
      "headers": {
        "Authorization": "Bearer ${BUTTERBASE_API_KEY}"
      }
    }
  }
}
```

## 主なツール

| 対象 | ツール |
|---|---|
| アプリ・リージョン | `init_app`、`manage_app`、`list_regions` |
| スキーマ・移行 | `manage_schema`、`manage_migrations` |
| 認証・利用者 | `manage_auth_config`、`manage_auth_users`、`manage_oauth`、`manage_people` |
| データ | `select_rows`、`insert_row`、`seed_database` |
| 関数 | `deploy_function`、`invoke_function`、`manage_function` |
| ストレージ・KV | `manage_storage`、`manage_kv` |
| フロントエンド・プレビュー | `create_frontend_deployment`、`manage_frontend`、`manage_edge_ssr`、`manage_preview`、`promote_preview` |
| RAG | `manage_rag_content`、`rag_query` |
| Realtime・DO | `manage_realtime`、`manage_durable_objects` |
| AI | `manage_ai`、`manage_agents` |
| RLS・コード | `manage_rls`、`manage_repo` |
| 外部連携・課金 | `manage_integrations`、`list_partner_apis`、`manage_billing` |
| キー・監査 | `manage_api_keys`、`query_audit_logs` |
| 文書・提案・ハッカソン | `butterbase_docs`、`submit_suggestion`、`prep_and_submit_hackathon_entry` |

`manage_app`は一覧・削除・一時停止・CORS・公開範囲・複製・テンプレート更新・substrate接続・移動・環境変数などを扱います。完全なaction一覧は[英語README](README.md#what-you-can-do)と、ローカル文書の`mcp`を参照してください。

## 日本語の文書と検索

`butterbase_docs`へ`{ "topic": "auth", "language": "ja" }`を渡すと、日本語の認証文書を取得できます。`{ "query": "ファイルのアップロード", "language": "ja" }`では日本語で検索します。`topic: "all"`は全文です。topicとqueryの両方があればtopicを優先します。

languageを省略すると従来の英語を返します。ツール名・トピック名・API値・コード例は共通です。文書ツールはローカルの読み取り専用処理で、APIやネットワークを呼びません。

## ライセンス

Apache-2.0 © NetGPT Inc. [LICENSE](https://github.com/butterbase-ai/butterbase/blob/main/LICENSE)を参照してください。
