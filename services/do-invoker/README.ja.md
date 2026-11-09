# do-invoker

[English](README.md) | 日本語

Fly上のdeno-runtimeなど、Cloudflare外のサービスから利用者のDurable Objectを呼び出すための、プラットフォーム所有のCloudflare Workerです。

## 動作

任意のパス・HTTPメソッドを受け、共有bearerの`DO_INVOKER_TOKEN`でプラットフォームの呼び出し元を認証します。

`x-butterbase-app`・`x-butterbase-class`・`x-butterbase-instance`ヘッダーから対象を読み取り、WfP dispatch namespaceの`${appId}_do` Workerへ転送します。

## デプロイ

    wrangler deploy

初回は`wrangler secret put DO_INVOKER_TOKEN`でbearerを登録します。ローカルでは`docker-compose.local.yml`の`do-invoker`サービスが`wrangler dev`をポート8787で実行します。wranglerのローカルモードではWfP dispatch namespaceを再現しないため、DOまでの往復には検証用Cloudflare環境が必要です。

## bearerの更新

このWorker・control-apiのFlyアプリ（`butterbase-platform`）・deno-runtimeのFlyアプリ（`butterbase-runtime`）でbearerを一致させます。

原文の運用では`CLOUDFLARE_ACCOUNT_ID`を指定して`scripts/rotate-do-invoker-token.sh`で3か所を更新します。このリポジトリの[更新スクリプト](../../scripts/rotate-do-invoker-token.sh)を使う運用手順です。一方だけを手動で変更すると相互の認証が失敗します。
