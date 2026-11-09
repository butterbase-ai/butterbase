# ローカル開発とテスト

[導入ガイド](../../../SETUP.ja.md) · [前：認証](./authentication.md) · [次：問題の切り分け](./troubleshooting.md)

## Control APIをホストで起動する

DB、Redis、ストレージなどはDockerで起動したままにします。

```bash
docker compose -f docker-compose.local.yml up -d control-plane-db data-plane-db runtime-plane-db redis localstack pgbouncer
cd services/control-api
export CONTROL_DB_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export KV_REDIS_URL_US_EAST_1=redis://localhost:6379
export AUTH_ENABLED=false
npm run dev
```

この例以外の環境変数も、Composeの `control-api.environment` に合わせます。`npm run dev` は変更時に再起動します。

## Denoをホストで起動する

Composeの `deno-runtime` と同じ環境変数を設定して実行します。

```bash
cd services/deno-runtime
deno run --allow-net --allow-env --allow-read server.ts
```

## ビルドする

リポジトリ直下で、ワークスペースを指定します。

```bash
npm run build --workspace=@butterbase/shared
npm run build --workspace=services/control-api
npm run build --workspace=services/mcp-server
```

## テストする

リポジトリ直下に `npm test` はありません。各ワークスペースで実行します。

```bash
npm test --workspace=services/control-api
npm test --workspace=services/mcp-server
npm test --workspace=@butterbase/shared
```

複数リージョンの統合テストは次のコマンドでCompose起動、マイグレーション、Vitestを行います。`vitest.e2e.config.ts` も確認してください。

```bash
npm run e2e:all
```

外部サービスを使うテストには、そのテストが要求する環境変数と実行環境が必要です。接続先を確認してから実行してください。
