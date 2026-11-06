---
title: エッジSSRのデプロイ
description: Next.jsとRemixのサーバーレンダリングをCloudflare Workersへ公開します。
---

Next.jsとRemixをButterbaseから公開できます。ローカルの@cloudflare/next-on-pagesで変換し、出力をzipにしてCloudflare Workersへ送ります。

:::tip[ローカルビルドを省く]
Windowsやツール導入を避けたい場合は[サーバー側ビルド](/ja/core-concepts/server-side-build/)を使います。依存導入とnext-on-pagesをButterbaseが実行します。
:::

<span id="what-is-edge-ssr"></span>

## エッジSSRとは

ButterbaseのWfP基盤でCloudflare Workers上にサーバー側処理を動かす方式です。静的配信と異なり、Server Actions、Route Handlers、動的描画、React Server Componentsを従来のNode.jsサーバーなしで利用できます。

**静的配信との違い：**
- **静的配信：** ViteのSPAやNext.jsの静的出力をCloudflare PagesからHTML・CSS・JSとして配信。
- **エッジSSR：** Workersがリクエスト時に描画し、Server Actionsを実行。

<span id="when-to-use-edge-ssr-vs-static"></span>

## 方式の選び方

| 用途 | 方式 | 備考 |
|----------|-----------|-------|
| React SPA（Vite） | 静的 | [フロントエンド公開](/ja/core-concepts/frontend-deployment) |
| Next.jsのoutput: export | 静的 | サーバー不要 |
| Next.js App Router（RSC、Server Components） | **Edge SSR** | next-on-pagesでビルド |
| Next.js Server Actions | **Edge SSR** | 静的ホストでは不可 |
| Next.js Route Handlers（/api/...） | **Edge SSR** | サーバー実行環境が必要 |
| Remixのサーバー処理 | **Edge SSR** | Workersアダプターで対応 |
| Vite／Create React App | 静的 | クライアント側の描画だけ |

<span id="prerequisites"></span>

## 事前準備

ビルド済み出力を送る場合、Next.jsを@cloudflare/next-on-pagesでWorkers対応形式へ**必ず変換**してください。

1. グローバルか開発依存として導入：

```bash
npm install -D @cloudflare/next-on-pages
# or
npx @cloudflare/next-on-pages
```

2. Next.jsのルートでビルド：

```bash
npx next build
npx @cloudflare/next-on-pages --build-cache-dir=.next
```

3. 出力を確認：

```bash
ls -la .vercel/output/static/
# Should contain _worker.js and other static assets
```

:::caution
ビルド済み方式で変換を省くと、_worker.js not foundなどで失敗します。**変換工程は必須**です。サーバー側ビルドではこの工程をサーバーが行います。
:::

<span id="deployment-flow"></span>

## デプロイ手順

<span id="option-1-cli"></span>

### 方法1：CLI

```bash
butterbase deploy:edge-ssr
```

このコマンドは次を行います。
- next-on-pagesが作った.vercel/output/static/を検出
- Workerとアセットを圧縮
- Butterbaseへ送信
- 自動でデプロイ開始

環境変数はダッシュボードかmanage_frontendのset_envで設定し、次のデプロイに適用します。CLIに--envはありません。

<span id="option-2-mcp"></span>

### 方法2：MCP

**手順1：作成**

```
create_edge_ssr_deployment({ app_id: "app_abc123", framework: "nextjs-edge" })
```

deployment_idとuploadUrlを返します。

**手順2：zipをアップロード**

```bash
cd .vercel/output/static/
zip -r ../../edge-ssr.zip .
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/zip" \
  --data-binary @edge-ssr.zip
```

**手順3：開始**

```
start_edge_ssr_deployment({ app_id: "app_abc123", deployment_id: "uuid-1234" })
```

<span id="supported-frameworks"></span>

## 対応フレームワーク

| フレームワーク | 値 | 備考 |
|-----------|-------|-------|
| Next.js | `nextjs-edge` | **v1で文書・テストを提供** |
| Remix | `remix-edge` | Workersアダプターで対応。Remixの文書を参照 |
| Workers対応のその他 | `other-edge` | 対応する_worker.jsを出力 |

:::note
v1で正式に文書化・テストしたのはNext.jsだけです。他もWorkers形式なら利用できますが、まずNext.jsを推奨します。
:::

<span id="runtime-constraints-critical"></span>

## ランタイムの制約

Workers上で動くため、公開前に次を確認してください。

<span id="no-arbitrary-nodejs-apis"></span>

### 任意のNode.js APIは使えない
- ❌ `fs`, `fs/promises`
- ❌ `child_process`
- ❌ ネイティブcrypto（Web Cryptoを使用）
- ❌ net、http（fetchを使用）

### Prisma
PrismaはHTTPの@prisma/adapter-neonを使います。

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { Pool } from '@neondatabase/serverless';

const neon = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaNeon(neon);
const prisma = new PrismaClient({ adapter });

export const POST = async (req: Request) => {
  const user = await prisma.user.create({ data: { ... } });
  return Response.json(user);
};
```

ネイティブのバイナリドライバーはWorkersで動きません。

<span id="timeouts-and-cpu"></span>

### 時間とCPU
- リクエストあたり最大30秒
- Worker呼び出しのCPUは30秒（プランによる）
- ストリーミングSSRは自動最適化

<span id="dependencies"></span>

### 依存
npmパッケージが対象のWorkersランタイムに対応するか確認します。Node.js APIが必要なものは、互換性設定も含めて検証してください。迷ったらローカルで試します。

```bash
npx @cloudflare/next-on-pages --build-cache-dir=.next
```

ビルドエラーが出たら依存の互換性を確認してください。

<span id="edge-runtime-requirement"></span>

## エッジランタイムの指定

next-on-pagesはエッジ指定のページ・ハンドラーを変換します。動的ページ、layout、Route Handlerの先頭へ次を追加します。

```ts
// app/some-page/page.tsx, app/api/foo/route.ts, etc.
export const runtime = 'edge';
```

未指定ではBUILD_NONZERO_EXITと非対応ページ一覧で失敗します。ただしuse serverのServer Actionsファイルは例外です。

<span id="server-actions-pitfalls"></span>

## Server Actionsの注意点

Next.jsの規則により、公開後に分かりにくいエラーや無応答になる場合があります。

<span id="allowedorigins-must-include-your-butterbase-subdomain"></span>

### allowedOriginsにアプリのドメインを含める

Server ActionsはCSRFチェックを行います。公開したbutterbase.devや独自ドメインが許可されない場合、呼び出しが拒否されます。next.config.jsへ公開元を追加してください。

```js
/** @type {import('next').NextConfig} */
module.exports = {
  experimental: {
    serverActions: {
      allowedOrigins: ['my-app.butterbase.dev', 'app.example.com'],
    },
  },
};
```

公開後に無応答や403になる場合は、まずこの設定を確認してください。

<span id="dont-put-export-const-runtime--edge-in-a-use-server-file"></span>

### use serverファイルにruntime定数を置かない

use serverファイルがexportできるのはasync関数だけです。runtime定数を置くとビルドが失敗します。読み込むページからランタイムを引き継ぐため、次のexportを除いてください。

```ts
// app/actions.ts
'use server';

// ❌ export const runtime = 'edge';  // breaks the build

export async function createPost(formData: FormData) { ... }
```

<span id="re-throw-next_redirect-inside-client-trycatch"></span>

### try/catchでNEXT_REDIRECTを再送出

redirect()はdigestがNEXT_REDIRECTで始まる例外を投げます。クライアント側で捕捉したままだと遷移しないため、再送出します。

```ts
try {
  await myServerAction(formData);
} catch (err: any) {
  if (err?.digest?.startsWith('NEXT_REDIRECT')) throw err;
  setError(err.message);
}
```

<span id="size-limits"></span>

## サイズ制限

- **Worker：** 圧縮後5 MB
- **全体：** 圧縮後100 MB（Workerと静的ファイル）

5 MBを超える場合：
1. next.config.jsでコード分割。
2. 重い処理を別のButterbase関数へ移す。
3. 未使用コードをビルドから除く。

next.config.jsの例：

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.optimization.splitChunks = {
      chunks: 'all',
      minSize: 20000,
    };
    return config;
  },
};

module.exports = nextConfig;
```

<span id="environment-variables"></span>

## 環境変数

ダッシュボードかmanage_frontendのset_envで設定し、次の公開で適用します。CLIに--envはありません。

REST APIでも設定できます。

```json
PUT /v1/{app_id}/edge-ssr/env

{
  "DATABASE_URL": "postgresql://...",
  "NEXT_PUBLIC_API_BASE": "https://api.butterbase.ai"
}
```

**注意：** デプロイ時にWorkerへ埋め込みます。変更の反映には再公開が必要です。

フレームワークの接頭辞：
- **Next.js：** NEXT_PUBLIC_はブラウザから見える公開用。サーバー用設定は構成に従う。
- **Remix：** 構成によるため.env.serverを確認。

<span id="replacement-semantics"></span>

## 置き換えの動作

アプリごとに有効なフロントエンドは**1つ**です。
- SSR公開で有効な静的配信を**置き換え**
- 静的公開で有効なSSRを**置き換え**
- 旧版は保持するが配信しない

戻すには旧版を再デプロイします。

<span id="troubleshooting"></span>

## 問題の対処

<span id="_workerjs-not-found-on-upload"></span>

### _worker.js not found

**原因：** next-on-pagesのビルドを省略。

**対処：** Next.jsのルートでビルド。

```bash
npx next build
npx @cloudflare/next-on-pages --build-cache-dir=.next
ls .vercel/output/static/_worker.js
```

その後.vercel/output/static/を送り直してください。

### WORKER_TOO_LARGE

**原因：** Workerが圧縮後5 MB超。

**対処：**
1. next.config.jsで分割（サイズ制限を参照）。
2. 重い依存を削除・置換。
3. 重い処理を別のサーバーレス関数へ移し、APIで呼ぶ。

### WRONG_BACKEND

**原因：** アプリの基盤がwfpではない。

**対処：** 新規はwfpが既定。古いアプリはサポートへ相談するか新規作成。

<span id="prismaneon-connection-errors"></span>

### Prisma・Neonの接続エラー

**原因：** Neonアダプターではなくネイティブドライバーを使用。

**対処：** @prisma/adapter-neonへ変更（ランタイム制約を参照）。

<span id="package-import-errors-at-runtime"></span>

### 実行時のimportエラー

**原因：** 依存がWorkers非対応のNode.js APIを使用。

**対処：** ローカルでビルドして警告を確認し、非対応依存を削除・置換。

<span id="monitoring-and-logs"></span>

## 監視とログ

ダッシュボードかlist_edge_ssr_deploymentsで確認します。リクエストログはアプリのFrontendに表示されます。
