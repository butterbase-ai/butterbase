# Butterbaseへの貢献

[English](./CONTRIBUTING.md) · 日本語

開発環境、OSS版の変更範囲、PRの手順を説明します。議論では相手を尊重し、人ではなく内容について意見を交わしてください。Contributor Covenantの精神に従います。

## このリポジトリが扱う範囲

OSS版は実行時のデータプレーンです。次の変更を受け付けています。

- Control APIの認証、ストレージ、関数、RLS、マイグレーション、AIゲートウェイの接続処理
- MCPツール、`agent-runtime` / `deno-runtime` / `build-runner` の改善
- SDK、CLI、プラグインの使いやすさ
- セルフホスト文書、サンプル、運用手順
- バグ修正、性能改善、セキュリティ強化

次の機能は非公開のクラウド用リポジトリにあります。

| 機能 | OSS側の接続先など |
|---|---|
| Stripeなどの課金連携 | `packages/shared` の `BillingProvider` |
| リース方式の使用量制限の計算 | `QuotaEnforcer` |
| プロバイダー別の認証情報を持つAIルーター | `RouterAdapter` |
| リージョン間ルーティング・アプリ移動の制御 | マネージド版の複数リージョン制御 |
| マネージド版の管理ダッシュボード | 非公開UI |

この境界に関わる提案は、最初にIssueを開き、OSS本体、別プラグイン、非公開機能のどこで扱うかを相談してください。

## 開発環境

Docker、Node.js 22以上、npmを用意し、[SETUP.ja.md](./SETUP.ja.md)に従って起動します。Gitサブモジュールも取得してください。

```bash
git clone --recurse-submodules https://github.com/butterbase-ai/butterbase.git
cd butterbase
git submodule update --init --recursive
npm ci
cp .env.example .env
docker compose -f docker-compose.local.yml up -d
export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export BUTTERBASE_REGIONS=us-east-1
npm run migrate:all
npm run seed:dev
curl -sf http://localhost:4000/health/ready
```

npm workspacesのモノレポです。コマンドはワークスペースを指定して実行します。

```bash
npm run build --workspace=services/control-api
npm test --workspace=@butterbase/shared
npm test --workspace=services/control-api
```

リポジトリ直下に `npm test` はありません。E2EテストはDocker Composeを起動して `npm run e2e:all` を実行します。外部サービスを使うテストは必要な環境変数がないとスキップされるので、各テストファイルを確認してください。

## PRの作成手順

1. 小さな変更を除き、実装前にIssueを開いて方針を相談します。
2. forkして `main` からブランチを作ります。名前は `feat/<short-desc>` または `fix/<short-desc>` にします。
3. PRは1つの課題に絞ります。
4. テストを追加します。特にRLS、認証、AIゲートウェイのリクエスト処理を重視します。
5. コミットメッセージは命令形にし、必要に応じて `feat(control-api):` や `fix(mcp):` を付けます。理由が明らかでない場合は空行の後に説明を書きます。
6. 定義されている `npm run typecheck` とワークスペースのテストを、push前に実行します。
7. `main` 宛てにPRを作成し、PRテンプレートを埋めます。

## コードの書き方

基本はTypeScriptです。シェルスクリプトと `dispatch-worker` / `bb-placeholder` のCloudflare Workerは例外です。ESM（`package.json` の `"type": "module"`）を使います。整形はPrettier、明らかな問題の検出はESLintを使い、CIでも実行します。

継承よりも部品の組み合わせを優先し、default exportよりnamed exportを使ってください。

## セキュリティ

脆弱性は公開Issueに書かないでください。[SECURITY.ja.md](./SECURITY.ja.md)の非公開報告手順に従います。運用ルールは [英語の原文](./CONTRIBUTING.md)も確認できます。

## ライセンス

貢献したコードが [Apache-2.0](./LICENSE) で公開されることに同意したものとします。
