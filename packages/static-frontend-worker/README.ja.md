# @butterbase/static-frontend-worker

[English](README.md) | 日本語

ButterbaseのWfP dispatch namespaceで使う、アプリごとの静的フロントエンドWorkerです。

`control-api`は`src/worker.ts`のコンパイル結果を各アプリのWorker（スクリプト名はappId）へアップロードします。Cloudflare Assets bindingの`html_handling: 'none'`と明示的なパス解決・SPAフォールバックを使います。

動作を変更する場合は`src/worker.ts`を編集し、再ビルドして`control-api`を再デプロイします。

## ファイル構成

```
src/
  worker.ts                       # the worker (typed TS, compiles to dist/worker.js)
  worker.test.ts                  # unit tests vs hand-mocked env.ASSETS
  worker.miniflare.test.ts        # integration tests vs real workerd
  index.ts                        # exports worker handler + WORKER_SOURCE constant
  worker-source.generated.d.ts    # committed shim for the build-time generated module
scripts/
  emit-source.mjs                 # post-build: dist/worker.js → dist/worker-source.generated.js
  local-server.mjs                # local Miniflare HTTP server (dev mode)
local-assets/                     # sample SPA shipped for first-run of dev:serve
Dockerfile                        # for the `miniflare-frontend` compose service
```

## ビルド

このパッケージのディレクトリで実行します。

```
npm run build
```

`src/worker.ts`から`dist/worker.js`を作成し、`emit-source.mjs`がその内容を文字列定数として`dist/worker-source.generated.js`へ出力します。`control-api`の`cloudflare-wfp.ts`は`WORKER_SOURCE`を読み込み、デプロイごとにそのままCloudflareへアップロードします。

tscの`--force`は必須です。ラッパーの`.dockerignore`は`dist/`を除外しても`tsconfig.tsbuildinfo`を残すため、Docker内の通常ビルドでは出力を省略する場合があります。

## テスト

```
npm test
```

- `worker.test.ts`：`env.ASSETS`を手動mockにしたVitestです。パス解決・SPA・ファイルがない場合の404・エラー処理を確認します。原文での目安は約20msです。
- `worker.miniflare.test.ts`：Miniflare 4の実workerdとAssets bindingを使います。mockと実環境の差を確認します。原文での目安は約2秒です。

Miniflareの既定動作はWorkerより先に静的ファイルへアクセスします。WfPではWorkerが入口なので、テストは`routerConfig.invoke_user_worker_ahead_of_assets: true`で本番に合わせています。

## 詳細

[ローカル開発](docs/ja/local-development.md)と[リダイレクト・本番デプロイ](docs/ja/routing.md)を参照してください。
