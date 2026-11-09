---
title: 開発前に確認すること
description: Butterbaseで開発する前に確認したい制約と構成の選び方。
---

開発を始める前に確認してください。5分ほどで読め、後から構成を作り直す手間を減らせます。

<span id="what-butterbase-is"></span>

## Butterbaseの役割

Butterbaseは、PostgreSQL、JWT認証、S3互換ストレージ、サーバーレス関数、フロントエンド配信を備えたバックエンドです。MCPやCLIからエージェントが操作できます。

<span id="what-butterbase-is-not"></span>

## 対応する実行環境と制約

<span id="not-a-full-nodejs--nextjs-hosting-platform"></span>

### Next.jsは静的出力またはWorkers向けSSRで配信する

Next.jsは次の2つの構成で使えます。
- **静的出力**（`next export`）：[フロントエンド配信](/ja/core-concepts/frontend-deployment)で静的ファイルを配信します。
- **SSRを使うNext.js**：[Edge SSR](/ja/core-concepts/edge-ssr-deployment)でCloudflare Workers向けにコンパイルして配信します。

通常のNode.jsサーバーとしてのNext.jsを、そのままアップロードして実行する構成には対応しません。`fs`、`child_process` などのNode.js固有APIを使う処理には実行環境の制約があります。サーバーレス関数の対応範囲も確認してください。

<span id="not-stateful-by-default"></span>

### 状態を持つ処理にはDurable Objectsを使う

通常は状態を保持しない [関数](/ja/core-concepts/functions/) または [Edge SSR](/ja/core-concepts/edge-ssr-deployment/)を使います。部屋やユーザーなどのキー別に状態を保つチャット、ゲーム、エージェントには [Durable Objects](/ja/core-concepts/durable-objects/)を使います。

<span id="not-mysqlmongodbetc"></span>

### DBはPostgreSQLを使う

DBは **PostgreSQLのみ**です。マネージド版ではNeonを使いますが、APIは通常のPostgreSQLです。MySQLやMongoDBなどには対応しません。

<span id="architecture-decision-tree"></span>

## 作るものに合わせて構成を選ぶ

作る機能に応じて次の構成を選びます。

- **ViteのSPA・静的HTML**：[フロントエンド配信](/ja/core-concepts/frontend-deployment)
- **`output: 'export'` のNext.js**：[フロントエンド配信](/ja/core-concepts/frontend-deployment)で静的配信
- **Server Actions・RSC・Route Handlersを使うNext.js**：`@cloudflare/next-on-pages` でビルドして [Edge SSR](/ja/core-concepts/edge-ssr-deployment)へ配信
- **RemixなどWorkers対応フレームワーク**：[Edge SSR](/ja/core-concepts/edge-ssr-deployment)
- **部屋・ユーザー別の状態を持つ処理**：[Durable Objects](/ja/core-concepts/durable-objects)。チャット、ゲーム、エージェント、ランキングなど
- **バックエンド処理・Webhook・API・cron**：Denoの [サーバーレス関数](/ja/core-concepts/functions)
- **DBの操作**：自動生成REST API、関数、Edge SSRからPostgreSQLを操作
- **ファイル送受信**：S3互換の [ファイル保存](/ja/core-concepts/storage)
- **即時の更新通知**：WebSocketの [リアルタイム通知](/ja/core-concepts/realtime)
- **AIモデルの呼び出し**：OpenAI互換APIの [AI機能](/ja/core-concepts/ai-integration)

<span id="common-gotchas"></span>

## 使う前に確認したい点

<span id="i-want-to-use-prisma"></span>

### Prismaを使う場合

HTTP接続用の `@prisma/adapter-neon` を使います。

```typescript
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';

// ✅ Works — HTTP over network
const prisma = new PrismaClient({
  adapter: new PrismaNeon(neon_connection_string),
});

// ❌ Doesn't work — binary driver
const prisma = new PrismaClient(); // fails without adapter
```

ソケット接続のバイナリドライバーを使うネイティブPrismaクライアントは、Cloudflare WorkersやDenoの関数の対象構成では使えません。

<span id="i-want-to-deploy-a-nextjs-app"></span>

### Next.jsをデプロイする場合

配信方法は2つあります。

1. **静的出力**（`next build && next export` → `out/`）：[フロントエンド配信](/ja/core-concepts/frontend-deployment)を使います。SSRは実行しません。
2. **SSR付きのNext.js**：`@cloudflare/next-on-pages` で先にコンパイルし、[Edge SSR](/ja/core-concepts/edge-ssr-deployment)へ配信します。通常の `npm run build` の手順を置き換えます。

ダッシュボードのフロントエンド配信は静的ファイル用です。通常のNode.jsサーバーを動かす別の配信方式はありません。

ローカルにビルドツールを入れない場合は、`butterbase deploy` または `butterbase deploy:edge-ssr` に `--from-source` を指定します。Cloudflare Containerで `npm install` とビルドを実行します。[サーバー側ビルド](/ja/core-concepts/server-side-build/)を参照してください。

<span id="my-function-uses-a-node-only-npm-package"></span>

### Node.js専用パッケージを使う場合

サーバーレス関数はDenoで実行します。`fs`、`path`、`child_process` などNode.js固有APIに依存するパッケージは、対象の実行環境で動作するか確認してください。

パッケージを使う前に確認します。
- Denoに対応しているか。READMEを確認するか、ローカルで試します。
- Cloudflare Workersに対応しているか。両方に対応するパッケージもあります。

判断できない場合は、デプロイ前に対象のEdge・サーバーレス環境でテストしてください。

<span id="where-to-go-next"></span>

## 次に読む

- [クイックスタート](/ja/getting-started/quickstart)：最初のアプリを作る
- [DBとスキーマ](/ja/core-concepts/database)：データモデルを定義する
- [サーバーレス関数](/ja/core-concepts/functions)：バックエンド処理を書く
- [フロントエンド配信](/ja/core-concepts/frontend-deployment)：静的ファイルを公開する
- [Edge SSR](/ja/core-concepts/edge-ssr-deployment)：Next.jsのSSRを配信する
- [認証の仕組み](/ja/core-concepts/authentication)：認証、RLS、リアルタイムを理解する
