---
title: サーバー側ビルド
description: ソースを送り、Cloudflare Container内で依存導入とビルドを実行して公開します。
---

ButterbaseがCloudflare Container内で`npm install`とビルドコマンドを実行します。ソースを送れば残りを処理するため、ローカルのビルド環境は不要です。Windowsや、ビルドツールを導入したくない場合に便利です。

<span id="what-it-is"></span>

## 仕組み

次の流れでデプロイします。
1. `package.json`と`package-lock.json`または`yarn.lock`を含むソースをpush
2. Cloudflare Container内で`npm install`を実行
3. `npm run build`や`npx @cloudflare/next-on-pages`などのビルドを実行
4. 出力をアプリへデプロイ

ローカルでのビルドや`@cloudflare/next-on-pages`の導入は不要で、Windows固有の互換性問題を避けられます。

<span id="when-to-use-it"></span>

## 向く用途

- **Windows：** ローカルの`@cloudflare/next-on-pages`が安定しない場合に利用。
- **ローカルツールを省く：** 手元にNode.js、npm、ビルドツールを入れずに公開。
- **CI/CD：** 事前ビルドを省いてパイプラインを簡略化。

ローカルでビルドする方法も利用できます。`butterbase deploy:edge-ssr`や`butterbase deploy`に`--prebuilt`を指定します。

<span id="supported-deploy-types"></span>

## 対応デプロイ方式

| 方式 | フレームワーク | 既定のビルド | 既定の出力先 |
|---|---|---|---|
| **Edge SSR** | Next.js | `npx @cloudflare/next-on-pages` | `.vercel/output/static` |
| **Edge SSR** | Remix | 自分のコマンド | 自分の出力先 |
| **静的** | Vite、CRA、Next-staticなど | `npm run build` | 自動判定（`dist`、`build`、`out`） |

<span id="quick-start"></span>

## クイックスタート

### Edge SSR (Next.js)

```bash
butterbase deploy:edge-ssr --from-source
```

Butterbaseが次を実行します。
- ソースをzipに圧縮
- `npm install`を実行
- `npx @cloudflare/next-on-pages`を実行
- `.vercel/output/static/`をデプロイ

<span id="static-frontend"></span>

### 静的フロントエンド

```bash
butterbase deploy --from-source
```

Butterbaseが次を実行します。
- ソースをzipに圧縮
- `npm install`を実行
- `npm run build`を実行
- 出力ディレクトリを自動判定
- 成果物をデプロイ

<span id="defaults-per-deploy-type"></span>

## 方式ごとの既定値

### Edge SSR

| 設定 | 値 |
|---|---|
| ビルドコマンド | `npx @cloudflare/next-on-pages` |
| 出力ディレクトリ | `.vercel/output/static` |
| 変更する場合 | 出力先が違う場合やRemixの構成 |

変更例：
```bash
butterbase deploy:edge-ssr --from-source --build-command "npm run build" --output-dir .output
```

<span id="static"></span>

### 静的

| 設定 | 値 |
|---|---|
| ビルドコマンド | `npm run build` |
| 出力ディレクトリ | `dist`、`build`、`out`の順で自動判定 |
| 変更する場合 | 標準以外の出力先 |

変更例：
```bash
butterbase deploy --from-source --build-command "npm run prod-build" --output-dir .public
```

<span id="override-flags"></span>

## 上書き用のフラグ

次は`butterbase deploy`と`butterbase deploy:edge-ssr --from-source`の両方で使えます。

| フラグ | 例 | 用途 |
|---|---|---|
| `--build-command` | `--build-command "npm run custom"` | ビルドコマンドを変更 |
| `--output-dir` | `--output-dir ./dist` | 出力先を変更 |
| `--from` | `--from ./my-app` | サブディレクトリからビルド（モノレポ対応） |

例：

```bash
butterbase deploy:edge-ssr --from-source \
  --build-command "npm run build:production" \
  --output-dir .vercel/output/static \
  --from apps/my-next-app
```

<span id="environment-variables"></span>

## 環境変数

ダッシュボードか`manage_frontend`（action：`set_env`）で設定します。次のデプロイから**ビルド時と実行時の両方**に適用します。

```bash
manage_frontend({
  app_id: "app_abc123",
  action: "set_env",
  vars: {
    "NEXT_PUBLIC_API_BASE": "https://api.example.com",
    "DATABASE_URL": "postgresql://...",
    "ANALYTICS_KEY": "secret-key"
  }
})
```

**注意：** ビルド時に公開用の環境変数を出力へ埋め込みます。
- **Next.js：** `NEXT_PUBLIC_*`はブラウザのJavaScriptから見え、他はサーバー専用
- **静的フロントエンド：** `NEXT_PUBLIC_*`などの公開用接頭辞を埋め込みます。ビルド時にシークレットが必要なら`.env.local`を使う工程を検討
- **Remixなど：** 構成によるため、フレームワークの環境変数の文書を確認

<span id="limits"></span>

## 制限

| 項目 | 値 | 備考 |
|---|---|---|
| ソースzip | 50 MB | 事前確認。超える場合は`.gitignore`形式で除外 |
| ビルド時間 | 5分 | 大きい依存や直列処理など遅い工程を見直す |
| メモリ | 2 GB | OOMなら依存を減らす |
| 圧縮済み成果物 | 25 MB | 未使用コードの除去や分割で削減 |
| ログ | 5 MB | 上限超過時は古い行から削除 |

<span id="caching"></span>

## キャッシュ

**`(app_id, lockfile_hash)`**をキーに、デプロイ間で`node_modules`を再利用します。

- **同じロックファイル** → キャッシュを使い、`npm install`を省略
- **ロックファイル変更** → 再利用せず、`npm install`を実行

`package-lock.json`と`yarn.lock`に対応します。依存の個別バージョンではなく、ロックファイルがキーです。

<span id="failure-modes"></span>

## 失敗時の対処

ダッシュボードかCLIのログを確認してください。主な原因は次のとおりです。

| 原因 | 意味 | 対処 |
|---|---|---|
| `BUILD_NONZERO_EXIT` | 依存導入かビルドが非ゼロ終了 | ログでコマンドや依存の問題を確認 |
| `BUILD_TIMEOUT` | 5分を超過 | 遅い工程を調べ、依存削減やビルド分割 |
| `BUILD_OOM` | 2 GBを超過 | 依存削減や分割。バンドラーのメモリ使用量も確認 |
| `SOURCE_TOO_LARGE` | ソースzipが50 MB超 | `.gitignore`で依存や大きいファイルを除外 |
| `OUTPUT_NOT_FOUND` | ビルド成功でも出力が空か存在しない | 正しい`--output-dir`を指定 |
| `ARTIFACT_TOO_LARGE` | 圧縮後25 MB超 | 未使用コード除去、分割、大きい依存の削除 |
| `DEPLOY_FAILED` | Cloudflare WfPが拒否 | ログとフレームワークの形式を確認（SSRの`_worker.js`など） |
| `INTERNAL` | Butterbase基盤の問題 | 不具合を報告して再試行 |

<span id="monitoring"></span>

## 監視

ダッシュボード、または`list_edge_ssr_deployments`（Edge SSR）／`list_static_deployments`（静的）のMCPツールで状態とログを確認します。

公開後のリクエストログは、ダッシュボードのアプリ内Frontendに表示されます。
