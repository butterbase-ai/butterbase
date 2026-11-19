# Build runnerのe2e

[English](README.md) | 日本語

設定済みのButterbase環境で、実際のビルド・デプロイを最後まで確認します。control-apiやCloudflareアカウントを自動mockには置き換えません。

## 確認する流れ

1. `e2e.fixture/`のNext.jsアプリをzipへまとめます。
2. `/v1/:appId/edge-ssr/deployments/from-source`へPOSTします。
3. 返された署名付きR2 URLへzipをPUTします。
4. `.../start`へPOSTします。`buildCommand`は`npx @cloudflare/next-on-pages`、`outputDir`は`.vercel/output/static`、`packageManager`は`npm`、lockfile hashはfixtureの`package-lock.json`のsha256先頭32桁です。
5. SSEログを購読し、1チャンク以上を受け取ることを確認します。
6. `GET /v1/:appId/edge-ssr/deployments/:id`をpollし、6分以内に`READY`か`FAILED`になることを確認します。
7. `READY`なら返された`url`へアクセスし、本文に`ok`があることを確認します。

## 必要な設定

| 環境変数 | 内容 |
|---|---|
| `CONTROL_API_URL` | from-source routeが設定されたcontrol-apiのベースURL |
| `BB_API_KEY` | テストアプリの`bb_sk_`付きAPIキー |
| `BB_APP_ID` | デプロイ先となる既存アプリのID |

control-api側にも、配置済みbuild-runner Workerを指す`BUILD_RUNNER_URL`、Workerと一致する`BUILD_RUNNER_SHARED_SECRET`、`source/`・`logs/`prefix用のR2認証情報が必要です。

## 実行

```bash
CONTROL_API_URL=https://api.butterbase.ai \
BB_API_KEY=bb_sk_... \
BB_APP_ID=app_... \
  npx vitest run services/build-runner/test/e2e.test.ts
```

3つの環境変数のいずれかがなければ、理由をconsoleへ表示してテストをskipします。未設定のCIでも環境不足だけで失敗しない構成です。
