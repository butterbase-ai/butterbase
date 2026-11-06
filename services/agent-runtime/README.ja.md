# agent-runtime

[English](README.md) | 日本語

Pydanticで表す宣言的graph specを、非同期で実行できるgraph runnerへコンパイルします。LLMのtool callingループ・toolノード・endノードを実行します。

内部サービスとして`control-api`から`INTERNAL_SERVICE_TOKEN`付きHTTPで呼びます。原文の運用構成では公開インターネットへ公開しません。各実行のステップ状態をPostgresの`agent_checkpoints`へ保存し、Redisへイベントを出してcontrol-api経由でクライアントへ配信します。

## 構成

```
control-api
    │  (internal-service-token, HTTP)
    ▼
agent-runtime
    ├── Pydantic spec model  →  graph compiler
    │       └── tool sources: built-in | MCP | function
    ├── Postgres checkpointer  (agent_checkpoints table, runtime DB)
    └── Redis event bus        (run events streamed back to control-api)
```

ツールは組み込み・リモートMCP・利用者定義関数の3種類から解決します。MCP認証ヘッダーは`AUTH_ENCRYPTION_KEY`で復号し、すべてのツール呼び出しを実行前に監査層へ記録します。

## 開発・テスト

[ローカル開発ガイド](docs/ja/local-development.md)に依存関係・環境変数・起動・mock・pytestをまとめています。例の鍵はプレースホルダーです。

## checkpoint

`src/agent_runtime/checkpoint.py`がruntime DBの`agent_checkpoints`へ、`run_id`・`step`をキーに書き込みます。テーブルは`db/runtime-plane/`のSQL migrationで作り、このサービス自身では作成しません。

## デプロイ

原文のFlyアプリは`butterbase-agent-runtime`で、設定は`services/agent-runtime/fly.toml`にあります。公開hostnameを持たない内部サービスです。`fly.toml`は`PORT=7140`と`ENV=production`を設定し、本番起動では`INTERNAL_SERVICE_TOKEN`・`AUTH_ENCRYPTION_KEY`が必須です。

`AUTH_ENCRYPTION_KEY`・`INTERNAL_SERVICE_TOKEN`・`OPENROUTER_API_KEY`・`CONTROL_PLANE_URL`はFly secretsへ保存します。pushを契機にした自動デプロイはありません。管理プラットフォームでは、非公開の親リポジトリのplatform Fly imageへ同梱し、`deploy.yml`の`workflow_dispatch`で手動デプロイします。

## トラブルシューティング

- **`queued`のまま進まない**：実行を取得するbackground taskの起動失敗が考えられます。`fly logs -a butterbase-agent-runtime`またはローカルログでtracebackを確認します。環境変数不足・DB接続失敗・importエラーが主な原因です。
- **AESGCMの復号エラー**：`AUTH_ENCRYPTION_KEY`が未設定かcontrol-apiと不一致です。両サービスへ同じ64桁のhexキーを設定します。
- **関数ツールでOpenAI 400のschemaエラー**：引数がなくても`args_schema`には`"properties": {}`が必要です。`{"type": "object"}`だけではOpenAI互換validatorに拒否されます。
