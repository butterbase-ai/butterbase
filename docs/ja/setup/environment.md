# コードの取得とサービス起動

[導入ガイド](../../../SETUP.ja.md) · [次：データベース](./database.md)

## コードを取得する

```bash
git clone --recurse-submodules https://github.com/butterbase-ai/butterbase.git
cd butterbase
git submodule update --init --recursive
npm ci
cp .env.example .env
```

`git submodule update` は再帰取得を省いた場合にも使えます。

## KV用Redisを設定する

ComposeはControl APIに `KV_REDIS_URL_US_EAST_1=redis://redis:6379` を設定します。Control APIをDockerの外で起動する場合だけ、ホスト用の値を `.env` などに設定します。

```bash
KV_REDIS_URL_US_EAST_1=redis://localhost:6379
```

`BUTTERBASE_REGIONS` の各リージョンに `KV_REDIS_URL_<REGION>` が必要です。`us-east-1` は `US_EAST_1` のように表記します。ローカルではポート6379の1台のRedisを使用量計測とKVの期限管理に使います。

`.env.example` のSentry、Stripe、OpenRouter、SES、R2の値は、既定のローカル構成には必須ではありません。`Invalid Sentry Dsn` はローカルでは無視するか、`.env` から `SENTRY_DSN` を取り除きます。Composeの外でControl APIを起動する場合は、リースやAIクレジットも `docker-compose.local.yml` の `control-api.environment` に合わせてください。

## サービスを起動する

```bash
docker compose -f docker-compose.local.yml up -d
docker compose -f docker-compose.local.yml ps
docker compose -f docker-compose.local.yml logs -f control-api
```

初回はモノレポを含むControl APIイメージのビルドに数分かかります。

| サービス | ポート | 役割 |
|---|---|---|
| `control-api` | 4000 | HTTP APIと `/mcp` |
| `deno-runtime` | 7133 | ユーザー関数の実行 |
| `docs` | 4321 | nginxによる文書配信 |
| `control-plane-db` | 5433 | プラットフォーム情報 |
| `data-plane-db` | 5435 | アプリ別DB |
| `runtime-plane-db` | 5437 | リージョン別の実行時テーブル |
| `pgbouncer` | 6432 | データプレーンの接続プール |
| `redis` | 6379 | 使用量計測とKVの期限管理 |
| `localstack` | 4566 | S3互換ストレージ |
| `traefik` | 80、8080 | ローカルのルーティング（任意） |

`agent-runtime`、`build-runner`、`storage-indexer`、`cron-scheduler`、ダッシュボードUIはこのComposeでは起動しません。起動後は [マイグレーションと開発ユーザー登録](./database.md)を行います。
