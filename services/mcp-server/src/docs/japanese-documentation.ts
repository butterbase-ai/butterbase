/** Static Japanese public docs, source: 1cba70c.
 * The local docs tool performs no filesystem, API, or network requests.
 */
import type { DocTopic } from './user-documentation.js';
export const JAPANESE_SECTIONS: Readonly<Record<Exclude<DocTopic, 'all'>, string>> = {
  overview: `AIと一緒に開発するためのバックエンドです。

Butterbaseは、AIを使うアプリ向けのBackend-as-a-Serviceです。PostgreSQL、JWT認証、S3互換のファイル保存を備えています。初期設定、DB操作、アップロードの各APIは共通のパターンと予測しやすい応答を持ち、エージェントから操作しやすく設計されています。

MCPサーバーへAIアシスタントを接続すると、指示を通じて文書の確認、バックエンドの設定、アプリの実装を進められます。バックエンドの専門知識がなくても始められます。

<span id="why-butterbase"></span>

## Butterbaseを作る理由

AIエージェントはフロントエンドのコードを効率よく生成できますが、DB設定、認証フロー、API設計などの複雑なバックエンドには専門知識が必要です。複数サービスの組み合わせや運用の専門知識に頼る負担を減らすため、コミュニティとともにButterbaseを開発しています。

<span id="what-you-get"></span>

## 使える機能

- **アプリ**：プロジェクトごとにDB、識別子、APIのベースURLを持つ独立したバックエンドを作ります。クライアントの開発に必要な情報を作成時に取得できます。
- **複数リージョン**：利用者に近い場所でデータを保存し、処理を実行できます。利用者が増えたら移動でき、同じAPI URLを各地から使えます。
- **宣言的スキーマ**：JSONでテーブルと列を定義し、現在のDBとの差分だけを適用します。実行前に変更を確認できます。
- **自動生成データAPI**：テーブルを作ると、HTTPで作成・読取・更新・削除（CRUD）、絞り込み、並べ替え、ページ分割を使えます。コード生成やルート設定は不要です。
- **利用者のログイン**：メールとパスワードの登録、ログイン、メール確認、パスワード再設定、OAuthによるソーシャルログインをアプリごとに設定できます。
- **ユーザー別のデータ制御（RLS）**：ログインした利用者が自分の行だけにアクセスするよう制限できます。1回のツール呼び出しでテーブルへ設定できます。
- **ファイル保存**：署名付きURLでアップロード・ダウンロードします。アプリとユーザー別に管理し、サイズ上限やコンテンツ種別を制限できます。
- **サーバーレス関数**：HTTPやcronで実行するTypeScript / JavaScript関数をデプロイします。アプリのDBや環境変数を使い、独自の応答を返せます。
- **フロントエンド配信**：React、Next.jsの静的出力、HTMLなどを1回のツール呼び出しで公開できます。各地への配信とHTTPSを備えます。
- **AIモデルゲートウェイ**：OpenAI互換APIからClaude、GPT-4、Llamaなどを呼び出します。自分のキーまたは使用量を記録するプラットフォームの共有キーを使えます。
- **組み込みRAG**：PDF、DOCX、TXTなどを取り込み、自然文で検索する処理を2回のAPI呼び出しで行います。文書の分割、\`text-embedding-3-small\` による埋め込み、pgvectorへの保存を扱うため、機械学習の基盤を別途用意する必要はありません。
- **リアルタイム通知**：WebSocketでデータ変更を通知します。RLSを考慮した絞り込み、プレゼンス、独自イベントのトリガーを使えます。
- **課金と使用量**：Free、Pro、Enterpriseプランで、AIクレジット、ストレージ、関数の呼び出し、転送量を計測します。
- **アプリの収益化**：Stripe Connectを必要に応じて接続し、利用者が自分で定義したプランに加入する流れを作れます。

<span id="typical-workflow"></span>

## 開発の流れ

1. アプリを作成し、\`app_id\` とAPIのベースURLを控えます。
2. テーブル、列、型、制約でスキーマを定義します。
3. dry-runで確認してからスキーマを適用します。
4. ユーザー別のデータを保存するテーブルへRLSを設定します。
5. メールとパスワード、OAuthなどのログイン方法を設定します。
6. 必要に応じてフロントエンドのドメインをCORSに設定します。
7. 独自のバックエンド処理をサーバーレス関数としてデプロイします。
8. モデルゲートウェイでAI機能を追加します。
9. 意味検索が必要なら、RAGコレクションへ文書を取り込みます。
10. フロントエンドを公開するか、自分のフロントエンドからデータAPIを呼び出します。
11. 課金ダッシュボードで使用量を確認します。

<span id="next-steps"></span>

## 次に読む

[フレームワークの例](https://docs.butterbase.ai/ja/guides/react/)で、ButterbaseとAIを使うアプリの作り方を確認してください。

- [クイックスタート](https://docs.butterbase.ai/ja/getting-started/quickstart/)：最初のアプリを5分で作る
- [MCPの接続](https://docs.butterbase.ai/ja/getting-started/mcp-setup/)：AIアシスタントを接続する
- [ダッシュボード](https://docs.butterbase.ai/ja/getting-started/dashboard/)：管理画面を使う

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
- **静的出力**（\`next export\`）：[フロントエンド配信](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/)で静的ファイルを配信します。
- **SSRを使うNext.js**：[Edge SSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/)でCloudflare Workers向けにコンパイルして配信します。

通常のNode.jsサーバーとしてのNext.jsを、そのままアップロードして実行する構成には対応しません。\`fs\`、\`child_process\` などのNode.js固有APIを使う処理には実行環境の制約があります。サーバーレス関数の対応範囲も確認してください。

<span id="not-stateful-by-default"></span>

### 状態を持つ処理にはDurable Objectsを使う

通常は状態を保持しない [関数](https://docs.butterbase.ai/ja/core-concepts/functions/) または [Edge SSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/)を使います。部屋やユーザーなどのキー別に状態を保つチャット、ゲーム、エージェントには [Durable Objects](https://docs.butterbase.ai/ja/core-concepts/durable-objects/)を使います。

<span id="not-mysqlmongodbetc"></span>

### DBはPostgreSQLを使う

DBは **PostgreSQLのみ**です。マネージド版ではNeonを使いますが、APIは通常のPostgreSQLです。MySQLやMongoDBなどには対応しません。

<span id="architecture-decision-tree"></span>

## 作るものに合わせて構成を選ぶ

作る機能に応じて次の構成を選びます。

- **ViteのSPA・静的HTML**：[フロントエンド配信](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/)
- **\`output: 'export'\` のNext.js**：[フロントエンド配信](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/)で静的配信
- **Server Actions・RSC・Route Handlersを使うNext.js**：\`@cloudflare/next-on-pages\` でビルドして [Edge SSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/)へ配信
- **RemixなどWorkers対応フレームワーク**：[Edge SSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/)
- **部屋・ユーザー別の状態を持つ処理**：[Durable Objects](https://docs.butterbase.ai/ja/core-concepts/durable-objects/)。チャット、ゲーム、エージェント、ランキングなど
- **バックエンド処理・Webhook・API・cron**：Denoの [サーバーレス関数](https://docs.butterbase.ai/ja/core-concepts/functions/)
- **DBの操作**：自動生成REST API、関数、Edge SSRからPostgreSQLを操作
- **ファイル送受信**：S3互換の [ファイル保存](https://docs.butterbase.ai/ja/core-concepts/storage/)
- **即時の更新通知**：WebSocketの [リアルタイム通知](https://docs.butterbase.ai/ja/core-concepts/realtime/)
- **AIモデルの呼び出し**：OpenAI互換APIの [AI機能](https://docs.butterbase.ai/ja/core-concepts/ai-integration/)

<span id="common-gotchas"></span>

## 使う前に確認したい点

<span id="i-want-to-use-prisma"></span>

### Prismaを使う場合

HTTP接続用の \`@prisma/adapter-neon\` を使います。

\`\`\`typescript
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';

// ✅ Works — HTTP over network
const prisma = new PrismaClient({
  adapter: new PrismaNeon(neon_connection_string),
});

// ❌ Doesn't work — binary driver
const prisma = new PrismaClient(); // fails without adapter
\`\`\`

ソケット接続のバイナリドライバーを使うネイティブPrismaクライアントは、Cloudflare WorkersやDenoの関数の対象構成では使えません。

<span id="i-want-to-deploy-a-nextjs-app"></span>

### Next.jsをデプロイする場合

配信方法は2つあります。

1. **静的出力**（\`next build && next export\` → \`out/\`）：[フロントエンド配信](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/)を使います。SSRは実行しません。
2. **SSR付きのNext.js**：\`@cloudflare/next-on-pages\` で先にコンパイルし、[Edge SSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/)へ配信します。通常の \`npm run build\` の手順を置き換えます。

ダッシュボードのフロントエンド配信は静的ファイル用です。通常のNode.jsサーバーを動かす別の配信方式はありません。

ローカルにビルドツールを入れない場合は、\`butterbase deploy\` または \`butterbase deploy:edge-ssr\` に \`--from-source\` を指定します。Cloudflare Containerで \`npm install\` とビルドを実行します。[サーバー側ビルド](https://docs.butterbase.ai/ja/core-concepts/server-side-build/)を参照してください。

<span id="my-function-uses-a-node-only-npm-package"></span>

### Node.js専用パッケージを使う場合

サーバーレス関数はDenoで実行します。\`fs\`、\`path\`、\`child_process\` などNode.js固有APIに依存するパッケージは、対象の実行環境で動作するか確認してください。

パッケージを使う前に確認します。
- Denoに対応しているか。READMEを確認するか、ローカルで試します。
- Cloudflare Workersに対応しているか。両方に対応するパッケージもあります。

判断できない場合は、デプロイ前に対象のEdge・サーバーレス環境でテストしてください。

<span id="where-to-go-next"></span>

## 次に読む

- [クイックスタート](https://docs.butterbase.ai/ja/getting-started/quickstart/)：最初のアプリを作る
- [DBとスキーマ](https://docs.butterbase.ai/ja/core-concepts/database/)：データモデルを定義する
- [サーバーレス関数](https://docs.butterbase.ai/ja/core-concepts/functions/)：バックエンド処理を書く
- [フロントエンド配信](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/)：静的ファイルを公開する
- [Edge SSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/)：Next.jsのSSRを配信する
- [認証の仕組み](https://docs.butterbase.ai/ja/core-concepts/authentication/)：認証、RLS、リアルタイムを理解する`,
  mcp: `MCPでAIアシスタントを接続すると、アプリ作成、スキーマ変更、認証設定、ファイル管理、関数のデプロイなどを構造化したツールで操作できます。

<span id="what-is-mcp"></span>

## MCPとは

**Model Context Protocol（MCP）** は、AIアシスタントを外部ツールやデータへ接続する標準です。Butterbaseを接続すると、アプリ作成、リージョン選択、スキーマ変更、認証、関数配信などのツールと、開始手順のプロンプトを使えます。

<span id="setting-up-the-mcp-connection"></span>

## MCPを接続する

<span id="option-1-claude-code-plugin-recommended"></span>

### 方法1：Claude Codeプラグイン（推奨）

Claude Code用のButterbase Skillsをインストールすると、MCPサーバーが自動設定され、開発を案内するスキルを使えます。

\`\`\`bash
# Add the marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase-skills@butterbase-skills
\`\`\`

APIキーを設定します。

\`\`\`bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
\`\`\`

プラグインには次の機能があります。
- **MCPの自動設定**：約40のツールと1つのプロンプトをすぐ使えます。
- **39スキルと34コマンド**：企画から計画、実装、配信を案内する \`/butterbase-skills:journey\` に加え、\`/butterbase-skills:build-app\`、\`/butterbase-skills:schema\`、\`/butterbase-skills:deploy\`、\`/butterbase-skills:debug-rls\`、\`/butterbase-skills:function\` などを使えます。
- **常時参照する情報**：環境変数、作業手順、実装パターンを提供します。

<span id="option-2-cli-setup"></span>

### 方法2：CLIから設定する

Butterbase CLIをインストール済みなら、次を実行します。

\`\`\`bash
butterbase plugin setup
\`\`\`

プロジェクトにMCP接続設定の \`.mcp.json\` を生成します。

<span id="option-3-manual-configuration"></span>

### 方法3：手動で設定する

\`.mcp.json\` またはエディターのMCP設定に追加します。

\`\`\`json
{
  "mcpServers": {
    "butterbase": {
      "url": "https://api.butterbase.ai/mcp",
      "headers": {
        "Authorization": "Bearer \${BUTTERBASE_API_KEY}"
      }
    }
  }
}
\`\`\`

Claude Code、Cursor、Windsurfなど、MCP対応のエディターで使えます。

<span id="mcp-over-http"></span>

### HTTP経由のMCP

接続先は次のエンドポイントです。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTPのMCPセッション |

AuthorizationヘッダーにAPIキーをBearerトークンとして渡します。

<span id="available-tools"></span>

## 利用できるツール

Butterbaseは38のツールを提供します。多くの機能は、\`action\` を指定する \`manage_*\` ツールにまとめています。各操作と引数は [MCPツール一覧](https://docs.butterbase.ai/ja/api-reference/mcp-tools/)で確認してください。

<span id="app-management"></span>

### アプリ管理

| ツール | 用途 |
|------|--------------|
| **init_app** | バックエンドを新規作成。名前と任意のリージョンを指定し、アプリIDとAPIのベースURLを取得。 |
| **list_regions** | アプリの作成・移動先に選べるリージョンの一覧。 |
| **manage_app** (action: "list") | アクセスできるアプリと情報の一覧。 |
| **manage_app** (action: "delete") | アプリとDBを完全削除。元に戻せません。 |
| **manage_app** (action: "get_config") | CORS、JWT、保存容量などの現在の設定を取得。 |
| **manage_app** (action: "update_cors") | ブラウザーからAPIへアクセスできるオリジンを設定。 |
| **manage_app** (actions: "pause", "update_access_mode", "secure", "set_visibility") | アプリの停止・再開、公開・認証必須の切り替え、テーブルのユーザー分離、テンプレート公開。 |
| **manage_app** (actions: "get_env", "update_env") | アプリ全体の環境変数を取得・設定。 |
| **manage_app** (actions: "find_templates", "clone", "get_clone_job", ...) | 公開テンプレートの検索・複製と、テンプレートのリリース操作。 |
| **manage_app** (actions: "move", "move_status", "teardown_source_replica") | アプリを別リージョンへ移動し、状態を確認。 |
| **manage_migrations** | 進行中のリージョン移動の確認・中断・逆移動。 |
| **manage_auth_config** (action: "update_jwt") | アクセストークンとリフレッシュトークンの有効期間を設定。 |
| **manage_auth_config** (action: "generate_service_key") | \`bb_sk_\` のAPIキーを生成。 |
| **manage_auth_config** (action: "configure_auth_hook") | 認証が成功した後に呼ぶ関数を設定。 |
| **manage_api_keys** | APIキーの一覧・失効。 |
| **manage_billing** | プラン・使用量の確認、クレジット追加、支出上限の管理。 |

<span id="schema--migrations"></span>

### スキーマとマイグレーション

| ツール | 用途 |
|------|--------------|
| **manage_schema** (action: "get") | アプリの現在のDBスキーマを取得。 |
| **manage_schema** (action: "apply") | 宣言的スキーマを適用。 |
| **manage_schema** (action: "dry_run") | 実行せずにSQLを確認。 |
| **manage_schema** (action: "list_migrations") | スキーマ変更の履歴を取得。 |

<span id="data-operations"></span>

### データ操作

| ツール | 用途 |
|------|--------------|
| **select_rows** | 絞り込み・並べ替え・ページ分割で行を検索。 |
| **insert_row** | テーブルへ行を追加。 |
| **seed_database** | 複数行を一括追加。 |

<span id="authentication--security"></span>

### 認証とセキュリティ

| ツール | 用途 |
|------|--------------|
| **manage_oauth** (actions: "configure", "get", "update", "delete") | ソーシャルログインのプロバイダーを登録・一覧取得・変更・削除。 |
| **manage_rls** (action: "enable") | テーブルのRLSを有効化。 |
| **manage_rls** (action: "create_policy") | 独自RLSポリシーを作成。 |
| **manage_rls** (action: "create_user_isolation") | ユーザー別の行アクセス制御を設定。 |
| **manage_rls** (actions: "list", "update_policy", "delete") | RLSポリシーの一覧・変更・削除。 |
| **manage_auth_users** (actions: "list", "delete") | アプリ利用者の一覧・削除。 |
| **query_audit_logs** | 認証・管理・関数の監査ログを検索。 |

<span id="storage"></span>

### ファイル保存

| ツール | 用途 |
|------|--------------|
| **manage_storage** (action: "upload_url") | 署名付きアップロードURLを取得。 |
| **manage_storage** (action: "download_url") | 署名付きダウンロードURLを取得。 |
| **manage_storage** (action: "list") | アプリのファイル一覧を取得。 |
| **manage_storage** (action: "delete") | ファイルを削除。 |
| **manage_storage** (action: "update_config") | 公開読取の可否とストレージ制限を設定。 |

<span id="serverless-functions-and-durable-objects"></span>

### 関数とDurable Objects

| ツール | 用途 |
|------|--------------|
| **deploy_function** | TypeScript / JavaScript関数をデプロイ。 |
| **invoke_function** | 配信した関数を試しに呼び出す。 |
| **manage_function** (actions: "list", "get", "delete") | 関数の一覧・詳細・削除。 |
| **manage_function** (action: "update_env") | 関数の環境変数を更新。 |
| **manage_function** (action: "get_logs") | 関数の呼び出しログを取得。 |
| **manage_function** (action: "update_settings") | 関数ごとの設定を変更。 |
| **manage_durable_objects** | Durable Objectsのデプロイ・管理と環境変数の設定。 |
| **manage_kv** | アプリのKVの設定・読取・書込。 |

<span id="frontend-deployment"></span>

### フロントエンド配信

| ツール | 用途 |
|------|--------------|
| **create_frontend_deployment** | 配信を作成してアップロードURLを取得。 |
| **manage_frontend** (action: "start_deployment") | アップロード後の配信を開始。 |
| **manage_frontend** (action: "list_deployments") | 配信履歴を取得。 |
| **manage_frontend** (action: "set_env") | ビルドの環境変数を設定。 |
| **manage_frontend** (action: "configure_custom_domain") | 独自ドメインの追加・検証・削除。 |
| **manage_edge_ssr** | Edge SSRのデプロイ・一覧。 |
| **manage_preview** | アプリのプレビューコピーを作成・管理。 |
| **promote_preview** | プレビューの変更を確認し、本番へ反映。 |
| **manage_repo** | アプリのコードスナップショットをpush・pull・確認。 |

<span id="realtime-ai-and-integrations"></span>

### リアルタイム・AI・外部連携

| ツール | 用途 |
|------|--------------|
| **manage_realtime** (actions: "configure", "get") | テーブルの通知を有効化し、設定を取得。 |
| **manage_ai** | AIゲートウェイのチャット・埋め込み・動画・画像・会議ボット。 |
| **manage_agents** | エージェントの定義を作成・管理。 |
| **manage_rag_content** | RAGのコレクションと文書を管理。 |
| **rag_query** | RAGコレクションを意味検索。 |
| **manage_integrations** | 外部ツールキットを有効化し、操作を実行。 |
| **manage_people** | 人物・企業を検索し、情報を補完。 |

<span id="hackathon-feedback--documentation"></span>

### ハッカソン・意見・文書

| ツール | 用途 |
|------|--------------|
| **list_partner_apis** | ハッカソン向けの提携APIを一覧取得。 |
| **prep_and_submit_hackathon_entry** | ハッカソン応募の準備と提出。 |
| **submit_suggestion** | 意見やバグ報告を送信。 |
| **butterbase_docs** | トピックを指定して文書を取得。 |

<span id="generating-an-api-key"></span>

## APIキーを作る

[ダッシュボード](https://dashboard.butterbase.ai)のAPI Keys、またはMCPの \`manage_auth_config\`（\`generate_service_key\`）でAPIキーを作れます。\`bb_sk_\` で始まるキーはアプリやデータへの管理アクセスに使います。

---

OSS版のMCPサーバーが公開するツールに加え、ホステッド版では\`manage_substrate\`を利用できます。多くの機能は\`action\`で操作を選ぶ\`manage_*\`ツールにまとめています（例：\`manage_schema\`の\`action: "apply"\`）。

MCPへ接続すると利用できます。接続方法は[MCPの設定](https://docs.butterbase.ai/ja/getting-started/mcp-setup/)を参照してください。

<span id="app-management"></span>

## アプリ管理

| ツール | 説明 |
|------|-------------|
| \`init_app\` | アプリを新規作成。任意の\`region\`を指定できます。app_idとAPIベースURLを返します。 |
| \`list_regions\` | アプリを作成・移動できるリージョンの一覧 |
| \`manage_app\` | アプリの一覧、削除、一時停止、アクセス・公開範囲の設定、リージョン移動、テンプレート複製、Webhook設定。以下の操作を参照してください。 |

<span id="manage_app-actions"></span>

### manage_appの操作

| 操作 | 説明 |
|--------|-------------|
| \`list\` | メタデータ付きの全アプリ一覧 |
| \`delete\` | アプリを完全に削除。元に戻せません。 |
| \`pause\` | データ処理の通信をすべて一時停止・再開。停止中は503（\`APP_PAUSED\`）を返します。 |
| \`get_config\` | アプリの設定（CORS、JWT、ストレージ上限）を取得 |
| \`secure\` | \`access_mode = "authenticated"\`と指定した\`tables\`のユーザー分離RLSポリシーを一括設定 |
| \`update_cors\` | CORSで許可するオリジンを設定 |
| \`update_access_mode\` | 匿名アクセスと認証必須を切り替える |
| \`set_visibility\` | 公開・非公開を設定。任意でテンプレート一覧の\`listed\`も指定できます。 |
| \`move\` | \`dest_region\`へ移動し、\`migration_id\`を返します。移動中も読み取りできます。 |
| \`move_status\` | \`move\`の\`migration_id\`で進行状況を確認 |
| \`teardown_source_replica\` | 完了した移動の\`migration_id\`を指定し、保持中の移動元のレプリカを廃止 |
| \`preview_clone_env_vars\` | 複製前に、元の関数とDurable Objectsが必要とする環境変数を確認。\`source_app_id\`を指定。 |
| \`find_templates\` | 公開・一覧表示が有効なテンプレートを検索。任意の\`q\`（前方一致）、\`region\`、\`sort\`（\`recent\`・\`popular\`）、\`limit\`（最大50）、\`offset\`。応答：\`{ items: [...], total, limit, offset }\`。 |
| \`clone\` | \`source_app_id\`の公開アプリを複製。任意の\`name\`・\`region\`。応答：\`{ job_id, status: "pending" }\`。 |
| \`get_clone_job\` | \`job_id\`で複製状況を確認。\`status\`（\`pending\`・\`completed\`・\`failed\`）、完了時の\`dest_app_id\`、失敗時の\`error_message\`を返します。 |
| \`set_clone_webhook\` | 複製時のWebhookを設定。\`webhook_url\`・\`webhook_secret\`を指定し、削除には\`clear_webhook: true\`を使います。 |
| \`link_substrate\` / \`unlink_substrate\` / \`set_substrate_autopropagate\` | アプリとSubstrateの紐付け・解除、イベントの自動伝播を設定 |
| \`publish_template_release\` / \`list_template_releases\` / \`get_template_release\` / \`check_template_updates\` / \`update_from_template\` | テンプレートのバージョン付きリリースを公開し、複製先で更新を確認・取得 |
| \`get_env\` | アプリの環境変数の**キー名だけ**を取得。値は返しません。応答：\`{ keys: string[], updated_at }\`。[環境変数](https://docs.butterbase.ai/ja/core-concepts/functions/#environment-variables)を参照。 |
| \`update_env\` | アプリの環境変数をマージ。\`env: { KEY: "value" }\`で設定、\`env: { KEY: null }\`で削除。全関数の\`ctx.env.<KEY>\`で使用できます。\`updated_keys\`とキャッシュを無効化した関数一覧を返します。\`/^BUTTERBASE_/i\`は予約済みです。 |

<span id="schema--migrations"></span>

## スキーマとマイグレーション

| ツール | 説明 |
|------|-------------|
| \`manage_schema\` | スキーマとマイグレーションの取得、適用、プレビュー、一覧 |
| \`manage_migrations\` | リージョン移動の取得と制御（\`manage_app\`の\`move\`を補完） |

<span id="manage_schema-actions"></span>

### manage_schemaの操作

| 操作 | 説明 |
|--------|-------------|
| \`get\` | 現在のスキーマを取得 |
| \`apply\` | 宣言したスキーマを適用。\`schema\`と任意の\`name\`を指定。 |
| \`dry_run\` | 実行せずにSQLを確認 |
| \`list_migrations\` | マイグレーション履歴を表示 |

<span id="manage_migrations-actions"></span>

### manage_migrationsの操作

| 操作 | 説明 |
|--------|-------------|
| \`get_active\` | 実行中のマイグレーション、または\`{ migration: null }\`を取得 |
| \`abort\` | 切り替え前の移動を中止。\`migration_id\`を指定。 |
| \`reverse\` | 移動元のレプリカが残っている間、完了した移動を元に戻す。\`migration_id\`を指定。 |
| \`list_source_replicas\` | 保持中の移動元レプリカを一覧表示 |

<span id="data-operations"></span>

## データ操作

| ツール | 説明 |
|------|-------------|
| \`select_rows\` | 絞り込み、並び替え、ページ分割で行を取得 |
| \`insert_row\` | 行を1件追加 |
| \`seed_database\` | 最大100行を一括追加。プラットフォームのロールで実行し、RLSを適用しません。 |

<span id="authentication--security"></span>

## 認証とセキュリティ

| ツール | 説明 |
|------|-------------|
| \`manage_oauth\` | ソーシャルログインのプロバイダーを設定 |
| \`manage_rls\` | テーブルの行レベルセキュリティを管理 |
| \`manage_auth_config\` | 認証フック、JWTの有効期間、サービスキーを管理 |
| \`manage_auth_users\` | エンドユーザーの一覧・削除 |
| \`manage_api_keys\` | プラットフォームAPIキーの一覧・失効 |
| \`query_audit_logs\` | 認証、管理、関数の監査ログを検索 |

<span id="manage_oauth-actions"></span>

### manage_oauthの操作

| 操作 | 説明 |
|--------|-------------|
| \`configure\` | プロバイダーを登録（\`provider\`、\`client_id\`、\`client_secret\`、\`redirect_uris\`） |
| \`get\` | 全プロバイダー、または\`provider\`指定で1件を取得 |
| \`update\` | プロバイダーを変更 |
| \`delete\` | プロバイダーを削除 |

<span id="manage_rls-actions"></span>

### manage_rlsの操作

| 操作 | 説明 |
|--------|-------------|
| \`enable\` | \`table_name\`にRLSを有効化 |
| \`create_policy\` | 独自ポリシーを作成（\`table_name\`、\`policy_name\`、\`command\`、\`role\`、\`using_expression\`、\`with_check_expression\`、任意の\`user_column\`） |
| \`update_policy\` | 既存のポリシーを変更 |
| \`create_user_isolation\` | ユーザー分離を設定。\`table_name\`、\`user_column\`、任意の\`public_read_column\`。 |
| \`list\` | 有効なポリシー一覧 |
| \`delete\` | \`policy_name\`の1件、またはテーブルの全ポリシーを削除 |

\`access_mode\`の変更や複数テーブルの一括保護には、\`manage_app\`の\`update_access_mode\`と\`secure\`を使います。

<span id="manage_auth_config-actions"></span>

### manage_auth_configの操作

| 操作 | 説明 |
|--------|-------------|
| \`configure_auth_hook\` | 認証イベントの成功後に実行する関数を設定・解除 |
| \`update_jwt\` | アクセストークンと更新トークンの有効期間を変更 |
| \`generate_service_key\` | サービスキーを発行 |

<span id="manage_auth_users-actions"></span>

### manage_auth_usersの操作

| 操作 | 説明 |
|--------|-------------|
| \`list\` | ユーザー一覧（\`limit\`、\`cursor\`） |
| \`delete\` | \`user_id\`でユーザーを削除 |

<span id="manage_api_keys-actions"></span>

### manage_api_keysの操作

| 操作 | 説明 |
|--------|-------------|
| \`list\` | APIキー一覧（\`bb_sk_\`で始まるキー） |
| \`revoke\` | \`key_id\`でキーを失効 |

<span id="app-repo"></span>

## アプリのリポジトリ

| ツール | 説明 |
|------|-------------|
| \`manage_repo\` | アプリのリポジトリを送信、取得、確認、全削除。MCPの送信は約1MBまでです。大きなスナップショットは\`butterbase repo push\`を使ってください。 |

<span id="storage"></span>

## ストレージ

| ツール | 説明 |
|------|-------------|
| \`manage_storage\` | 署名付きアップロード・ダウンロードURL、ファイルの一覧・削除、設定 |

<span id="manage_storage-actions"></span>

### manage_storageの操作

| 操作 | 説明 |
|--------|-------------|
| \`upload_url\` | アップロードURLを取得。\`filename\`、\`content_type\`、\`size_bytes\`を指定し、\`object_id\`を返します。 |
| \`download_url\` | \`object_id\`のダウンロードURLを取得 |
| \`list\` | 全ファイルを一覧表示 |
| \`delete\` | \`object_id\`で削除 |
| \`update_config\` | アプリ全体の公開読み取りとストレージ上限を設定 |

<span id="serverless-functions"></span>

## サーバーレス関数

| ツール | 説明 |
|------|-------------|
| \`deploy_function\` | TypeScript・JavaScriptの関数をデプロイ |
| \`invoke_function\` | 関数をテスト実行 |
| \`manage_function\` | 関数の一覧、確認、削除、設定、ログ取得 |

<span id="manage_function-actions"></span>

### manage_functionの操作

| 操作 | 説明 |
|--------|-------------|
| \`list\` | デプロイ済みの関数一覧 |
| \`get\` | 関数の詳細を取得 |
| \`delete\` | 関数を削除 |
| \`get_logs\` | 呼び出しログを表示 |
| \`update_env\` | **関数単位**の環境変数を更新。アプリの同名キーより優先します。全関数で共有する値は\`manage_app\`の\`update_env\`を使います。[環境変数](https://docs.butterbase.ai/ja/core-concepts/functions/#environment-variables)を参照。 |
| \`update_settings\` | \`allow_service_key_impersonation\`などの設定を更新 |

## Durable Objects

| ツール | 説明 |
|------|-------------|
| \`manage_durable_objects\` | Durable Objectsのデプロイと管理 |

<span id="manage_durable_objects-actions"></span>

### manage_durable_objectsの操作

\`deploy\`, \`list\`, \`get\`, \`delete\`, \`usage\`, \`list_env\`, \`set_env\`, \`delete_env\`.

<span id="frontend-deployment"></span>

## フロントエンドのデプロイ

| ツール | 説明 |
|------|-------------|
| \`create_frontend_deployment\` | デプロイを作成し、アップロードURLを取得 |
| \`manage_frontend\` | デプロイ開始、履歴、ビルド環境変数、カスタムドメインの管理 |
| \`manage_edge_ssr\` | Edge SSR（Cloudflare Workers）のデプロイと一覧 |

<span id="manage_frontend-actions"></span>

### manage_frontendの操作

| 操作 | 説明 |
|--------|-------------|
| \`start_deployment\` | アップロード後に開始。\`deployment_id\`を指定。 |
| \`list_deployments\` | デプロイ履歴を表示 |
| \`create_from_source\` / \`start_from_source\` | ソースZIPからサーバー側でビルド |
| \`set_env\` | ビルド環境変数（\`vars\`）を設定 |
| \`configure_custom_domain\` | \`domain_action\`（\`add\`、\`list\`、\`status\`、\`verify\`、\`remove\`）でドメインを追加、一覧、確認、検証、削除 |

<span id="manage_edge_ssr-actions"></span>

### manage_edge_ssrの操作

\`create\`, \`start\`, \`create_from_source\`, \`start_from_source\`, \`list\`.

<span id="previews"></span>

## プレビュー

| ツール | 説明 |
|------|-------------|
| \`manage_preview\` | 本番のコピーとしてプレビューを作成・管理。操作：\`create\`、\`status\`、\`reset\`、\`get_env_overrides\`、\`set_env_overrides\`。 |
| \`promote_preview\` | プレビューの構造とコードを本番へ反映。操作：\`check\`、\`run\`。 |

<span id="realtime"></span>

## リアルタイム

| ツール | 説明 |
|------|-------------|
| \`manage_realtime\` | リアルタイムの有効化・設定取得。操作：\`configure\`（\`tables\`を有効化）、\`get\`。 |

<span id="ai-gateway"></span>

## AIゲートウェイ

AIの操作は\`manage_ai\`にまとめています。\`{ app_id, action, ... }\`の\`action\`で選択します。

| 操作 | 説明 |
|--------|-------------|
| \`chat\` | 同期のチャット補完（OpenAI互換）。\`messages\`、任意の\`model\`、\`temperature\`、\`max_tokens\`。 |
| \`embed\` | 埋め込みを生成。\`input\`（文字列または配列）、任意の\`model\`、\`encoding_format\`。 |
| \`list_models\` | アプリで利用できるチャット・埋め込み・動画モデル一覧 |
| \`get_config\` | AI設定（既定モデル、許可モデル、トークン上限）を取得 |
| \`update_config\` | 持ち込みキー（BYOK）の更新、既定モデル、許可モデルを設定 |
| \`get_usage\` | 期間内のトークン数とクレジット消費を集計 |
| \`submit_video\` | 非同期の動画生成。\`model\`、\`prompt\`、任意の\`duration\`、\`resolution\`、\`aspect_ratio\`、\`generate_audio\`、\`seed\`。応答：\`{ job_id, status, polling_url }\`。 |
| \`poll_video\` | \`job_id\`で状態を確認。\`completed\`なら絶対URLの\`content_urls\`と\`charged_credits_usd\`を返します。 |
| \`configure_meetings_webhook\` | 会議ボットの転送先を設定。\`forward_url\`と、任意の\`rotate_secret: true\`で署名用シークレットを更新します。シークレットは**1回だけ**返します。[署名の検証](https://docs.butterbase.ai/ja/api-reference/ai-meetings-api/#verifying-the-signature)を参照してください。 |
| \`decide\` | 選択肢を限定した判断 |
| \`submit_image\` / \`poll_image\` | 非同期の画像生成を送信・確認 |
| \`start_meeting\` / \`get_meeting\` / \`list_meetings\` / \`stop_meeting\` / \`estimate_meeting\` | 会議ボットを起動、取得、一覧、停止、料金見積もり |
| \`usage_meetings\` | 会議の使用量。\`actor_id\`、項目（\`recording\`・\`transcription\`）、\`seconds\`、\`usd_charged\`、\`created_at\`。最新100件。 |

HTTPの形式と動画生成の一連の例は[AI APIリファレンス](https://docs.butterbase.ai/ja/api-reference/ai-api/)を参照してください。

<span id="rag-retrieval-augmented-generation"></span>

## RAG（検索拡張生成）

| ツール | 説明 |
|------|-------------|
| \`manage_rag_content\` | コレクションと文書を管理 |
| \`rag_query\` | コレクションの意味検索。順位付きのチャンクを返し、任意でAIの回答を生成。 |

<span id="manage_rag_content-actions"></span>

### manage_rag_contentの操作

| 操作 | 説明 |
|--------|-------------|
| \`create_collection\` | 文書の保存と検索用のコレクションを作成 |
| \`list_collections\` | 文書数付きのコレクション一覧 |
| \`get_collection\` | コレクションを1件取得 |
| \`delete_collection\` | コレクションと文書、チャンク、埋め込みを全削除 |
| \`ingest_document\` | テキストまたはアップロード済みファイルを非同期で取り込み。文書IDを返します。 |
| \`list_documents\` | 状態とメタデータ付きの文書一覧 |
| \`get_document_status\` | 取り込み状態を確認（\`pending\`、\`processing\`、\`ready\`、\`failed\`） |
| \`delete_document\` | 文書とベクトルチャンクを削除 |

<span id="integrations"></span>

## 外部サービスとの連携

| ツール | 説明 |
|------|-------------|
| \`manage_integrations\` | GmailやSlackなどのツールキットを有効化し、操作を実行 |

<span id="manage_integrations-actions"></span>

### manage_integrationsの操作

| 操作 | 説明 |
|--------|-------------|
| \`configure\` | アプリのツールキットを有効化 |
| \`rotate_credentials\` | OAuthの認証情報を更新 |
| \`disable\` | ツールキットを無効化 |
| \`list_available\` | 選定されたツールキット一覧、または全体から検索 |
| \`list_connected\` | アプリにアカウントを接続したユーザー一覧 |
| \`list_tools\` | 接続済みツールキットの実行可能なツール一覧 |
| \`execute_action\` | ユーザーに代わってツールを実行 |

<span id="agents"></span>

## エージェント

| ツール | 説明 |
|------|-------------|
| \`manage_agents\` | エージェント定義の管理。操作：\`list\`、\`get\`、\`create\`、\`update\`、\`delete\`、\`validate\`。 |

<span id="people-people--company-search--enrichment"></span>

## 人物と企業の検索・情報補完

| ツール | 説明 |
|------|-------------|
| \`manage_people\` | 人物・企業の条件検索や意味検索、LinkedIn URLからの情報補完（30日キャッシュ）、非同期の勤務先メール検索。ユーザーのクレジットから課金します。[人物検索API](https://docs.butterbase.ai/ja/api-reference/people-api/)にHTTP形式と料金を掲載しています。 |

各操作は、設定可能な2つの接続先（\`primary\`、\`secondary\`）のいずれかへ送信します。運営者がデプロイ時に指定し、MCPの呼び出し元には公開しません。

<span id="manage_people-actions"></span>

### manage_peopleの操作

すべて\`{ app_id, action, ... }\`の\`action\`で操作を選択します。

| 操作 | 説明 |
|--------|-------------|
| \`search_person\` | 構造化したフィルターと自由文の\`query\`による人物検索。\`query\`があれば優先します。フィルター：\`current_role_title\`、\`past_role_title\`、\`current_company_name\`、\`current_company_industry\`、\`country\`、\`region\`、\`city\`、\`education_school_name\`、\`education_degree_name\`、\`education_field_of_study\`、\`page_size\`、\`next_token\`。論理演算子は順位の参考です。0件なら無料。 |
| \`search_company\` | 企業の条件検索・意味検索。\`query\`と、\`industry\`、\`country\`、\`employee_count_max\`、\`page_size\`、\`next_token\`。 |
| \`get_profile\` | \`linkedin_profile_url\`でプロフィールを取得。\`live_fetch: "force"\`でキャッシュを省略。未取得は2クレジット、キャッシュは無料。TTL：成功30日、404は7日、失敗1時間。 |
| \`queue_email_lookup\` | \`linkedin_profile_url\`で非同期検索を受付。\`lookup_id\`と\`status: "pending"\`を返し、\`get_email_lookup\`で確認します。目安は受付時3クレジット、確定時1クレジット。 |
| \`set_byok_key\` / \`clear_byok_key\` | 自分のプロバイダーキー（BYOK）を保存・削除 |
| \`get_email_lookup\` | \`id\`で検索結果を確認。応答：\`{ status, email, credits_consumed }\`。 |

<span id="search-examples"></span>

### 検索の例

\`\`\`jsonc
// Semantic query — natural-language description of the ideal match
{
  "action": "search_person",
  "query": "founder of a YC-backed AI startup based in San Francisco",
  "page_size": 25
}

// Structured filters — boolean syntax honored as ranking hints
{
  "action": "search_person",
  "current_role_title": "(VP OR \\"Vice President\\") AND NOT assistant",
  "education_school_name": "(Harvard OR Stanford OR MIT OR Princeton OR Yale)",
  "country": "US",
  "page_size": 25
}

// Company search
{
  "action": "search_company",
  "industry": "Financial Services",
  "employee_count_max": 200,
  "country": "US"
}

// Profile lookup — cache absorbs duplicates within 30 days
{ "action": "get_profile", "linkedin_profile_url": "https://www.linkedin.com/in/jane-doe-abc123" }
\`\`\`

<span id="pricing-summary"></span>

### 料金の概要

料金は運営者の接続先指定により異なります。表は通常の目安です。実際の料金は\`x-people-*\`ヘッダーと本文の\`usage\`で確認できます。全体の料金表は[人物検索API](https://docs.butterbase.ai/ja/api-reference/people-api/#pricing)を参照してください。

| 操作 | 通常のクレジット数 | 通常の米ドル料金 |
|---|---|---|
| \`search_person\` / \`search_company\`（最大10件） | 7 | $0.0084 |
| \`get_profile\`のキャッシュ未取得 | 2 | $0.040 |
| \`get_profile\`のキャッシュ取得 | 0 | $0 |
| \`queue_email_lookup\`の受付 | 3 | $0.060 |
| Webhookによるメール確定 | 1 | $0.020 |
| 検索結果なし（0件） | 0 | $0 |

<span id="errors"></span>

### エラー

\`manage_people\`は、control-apiのエラー文と\`isError: true\`を返します。主な原因は次のとおりです。

- \`insufficient_credits\`（402）：残高が最低利用額（既定値0.05米ドル）未満です。プロバイダーは呼び出しません。
- \`forbidden\`（403）：認証済みのユーザーがアプリの所有者ではありません。
- \`people_disabled\`（503）：この環境で機能フラグが無効です。
- \`people_unavailable\`（503）：機能が無効、または必要なプラットフォーム設定がありません。
- \`provider_not_registered\`（503）：運営者の設定不備。指定の枠にプロバイダーがありません。
- \`provider_action_unsupported\`（503）：運営者の設定不備。指定の枠のプロバイダーが操作に対応していません。

<span id="conceptual-notes"></span>

### 利用時の補足

- **キャッシュで料金を抑える。** 同じ正規化済みのLinkedIn URLを30日以内に再取得する\`get_profile\`は無料です。再表示時にも取得できます。
- **検索結果が0件ならクレジットも0。** \`page_size: 1\`で\`data.totalResultCount\`を確認し、次のページを取得する前の料金の目安に使えます。
- **メール検索は非同期。** 受付はすぐに返し、結果は数分後にWebhookで届きます。UIに\`pending\`状態を用意してください。
- この提供範囲では**電話番号に対応していません**。

<span id="kv-store"></span>

## KVストア

| ツール | 説明 |
|------|-------------|
| \`manage_kv\` | KVの公開ルールと、取得・保存・削除・加減算などのデータ操作 |

<span id="manage_kv-actions"></span>

### manage_kvの操作

| 操作 | 説明 |
|--------|-------------|
| \`list_rules\` | 全名前空間の公開ルール一覧 |
| \`expose\` | キーパターンの読み書き権限を設定 |
| \`unexpose\` | パターンで公開ルールを削除 |
| \`stats\` | 使用量（キー数、メモリなど）を取得 |
| \`scan\` | プレフィックスで走査（カーソルによるページ分割） |
| \`flush\` | 全キーを削除（\`confirm: true\`が必須） |
| \`get\` | キーの値を取得 |
| \`set\` | 値を保存。任意のTTLと一時層の指定。 |
| \`del\` | キーを1件削除 |
| \`incr\` | 整数値を加算 |
| \`decr\` | 整数値を減算 |
| \`setnx\` | 存在しない場合だけ保存 |
| \`setex\` | 秒単位のTTLを指定して保存 |
| \`cas\` | 現在値がexpectedと一致する場合だけnextへ不可分に置換 |
| \`exists\` | キーの存在を確認 |
| \`ttl\` | 残りのTTLを秒単位で取得 |
| \`expire\` | 既存のキーにTTLを設定 |
| \`mget\` | 複数の値を一括取得 |
| \`mset\` | 複数のキーと値を一括保存 |

<span id="manage_kv-example"></span>

### manage_kvの例

\`\`\`json
{
  "action": "manage_kv",
  "app_id": "app_abc123",
  "action": "set",
  "key": "counter:requests",
  "value": 42,
  "ttl": 3600
}
\`\`\`

## Substrate

> ホステッド版（butterbase.ai）専用です。\`manage_substrate\`はマネージドサービスに含まれ、OSS版のMCPサーバーでは提供しません。

Substrateの操作は\`manage_substrate\`にまとめています。\`{ action, ... }\`で選択します。呼び出すユーザーは認証情報から決まるため、\`app_id\`や\`substrate_user_id\`は指定しません。各呼び出しは自分のSubstrateを操作します。

| ツール | 説明 |
|------|-------------|
| \`manage_substrate\` | 自分のSubstrateの読み書き。アクション、台帳、エンティティ、元資料、メモリー、Outbox、注意ルール、スナップショット、yolo設定を管理。 |

<span id="manage_substrate-actions"></span>

### manage_substrateの操作

決定、約束、学び、エンティティ、元資料、外部への操作など、すべての書き込みで該当する\`capability\`を指定して\`propose\`を使います。

| 操作 | 説明 |
|--------|-------------|
| \`propose\` | \`capability\`と\`payload\`で提案。任意の\`idempotency_key\`、\`dangerously_skip_approval\`。応答：\`{ action_id, verdict, requires_approval, result? }\`。 |
| \`approve\` | \`action_id\`の承認待ちアクションを承認 |
| \`reject\` | \`action_id\`を拒否。任意の\`reason\`。 |

アクションの台帳。

| 操作 | 説明 |
|--------|-------------|
| \`list_actions\` | 台帳一覧。任意の\`status\`（\`proposed\`・\`executed\`・\`rejected\`）、\`capability\`、\`source_app_id\`、\`source_rule_id\`、\`limit\`（1〜500、既定100）、\`before\`（ISO日時）。 |
| \`get_action\` | \`action_id\`で取得 |

エンティティ。

| 操作 | 説明 |
|--------|-------------|
| \`find_entities\` | エンティティ検索。任意の\`type\`（\`person\`・\`company\`・\`fund\`・\`workspace\`・\`team\`・\`project\`・\`event\`・\`agent\`・\`self\`）、\`q\`（表示名）、\`limit\`（1〜200、既定50）。 |
| \`get_entity\` | \`entity_id\`で取得 |

元資料。会議の文字起こし、メール、録音、文書などの永続的な資料で、決定・約束・学びから参照できます。

| 操作 | 説明 |
|--------|-------------|
| \`list_source_artifacts\` | 元資料の一覧・全文検索。任意の\`kind\`、\`q\`（title＋summary＋content）、\`limit\`、\`count\`（\`true\`で\`total\`を含む）。 |
| \`get_source_artifact\` | \`artifact_id\`で全文の\`content\`を含めて取得 |

メモリー。

| 操作 | 説明 |
|--------|-------------|
| \`search_memory\` | メモリーの全文検索。\`q\`、任意の\`kinds\`（\`decisions\`・\`commitments\`・\`learnings\`・\`source_artifacts\`、既定はすべて）、\`limit\`。 |

Outbox。

| 操作 | 説明 |
|--------|-------------|
| \`list_outbox\` | 配信一覧。任意の\`status\`と\`limit\`。 |
| \`retry_outbox\` | \`outbox_id\`の失敗した配信を再試行 |
| \`cancel_outbox\` | \`outbox_id\`の待機中の配信を中止 |

注意ルール。

| 操作 | 説明 |
|--------|-------------|
| \`list_rules\` | ルール一覧。任意の\`enabled\`で絞り込み。 |
| \`get_rule\` | \`rule_id\`で取得 |
| \`create_rule\` | \`rule\`を指定して作成。[Substrate API](https://docs.butterbase.ai/ja/api-reference/substrate-api/#attention-rules)に本文を掲載。 |
| \`update_rule\` | \`rule_id\`と\`rule\`で更新 |
| \`delete_rule\` | \`rule_id\`で削除 |
| \`enable_rule\` | \`rule_id\`を有効化 |
| \`disable_rule\` | \`rule_id\`を無効化 |
| \`list_rule_firings\` | 発火履歴。\`rule_id\`、任意の\`status\`、\`limit\`、\`before\`。 |

スナップショットと設定。

| 操作 | 説明 |
|--------|-------------|
| \`snapshots\` | 日次スナップショット一覧。任意の\`days\`（既定7）。 |
| \`get_settings\` | ユーザー設定（yoloモードなど）を取得 |
| \`set_yolo\` | \`yolo_mode: true\`または\`false\`で切り替え |

<span id="manage_substrate-example"></span>

### manage_substrateの例

\`\`\`json
{
  "tool": "manage_substrate",
  "action": "propose",
  "capability": "upsert_source_artifact",
  "payload": {
    "kind": "meeting_transcript",
    "title": "Weekly product sync — 2026-06-09",
    "external_system": "fireflies",
    "external_id": "abc123",
    "content": "Alice: we should ship phase 6 by Friday…"
  }
}
\`\`\`

<span id="billing"></span>

## 課金

| ツール | 説明 |
|------|-------------|
| \`manage_billing\` | アカウントの課金管理。操作：\`status\`、\`portal\`、\`topup\`、\`cap_get\`、\`cap_raise\`、\`plans\`、\`usage\`。 |

<span id="partner-apis--regions"></span>

## パートナーAPIとリージョン

| ツール | 説明 |
|------|-------------|
| \`list_partner_apis\` | ハッカソンで利用できるパートナーAPI一覧 |
| \`list_regions\` | 利用できるリージョン一覧 |

<span id="hackathon"></span>

## ハッカソン

いずれかのハッカソンの応募期間中に一覧へ表示します。複数のハッカソンが同時に開催される場合があるため、対象を指定するツールには\`hackathon_slug\`が必要です。[ハッカソン](https://docs.butterbase.ai/ja/hackathon/)を参照してください。

| ツール | 説明 |
|------|-------------|
| \`prep_and_submit_hackathon_entry\` | 2段階の提出。\`prep\`は\`submission_code\`から対象と\`field_schema\`、各フィールドの仮値を含む\`next_call\`を返します。確認した\`data\`を\`submit\`へ送り、\`matched.slug\`を\`hackathon_slug\`に使います。初回は\`submission_code\`も必要です。\`manage_app\`の\`list\`で取得した\`app_id\`も指定すると、自動採点と審査でアプリを確認できます。 |

<span id="feedback--documentation"></span>

## フィードバックとドキュメント

| ツール | 説明 |
|------|-------------|
| \`submit_suggestion\` | フィードバック、不具合、機能要望を送信 |
| \`butterbase_docs\` | トピック別のドキュメントを取得 |`,
  rest: `スキーマツールでテーブルを作成すると、REST APIを自動で利用できます。コード生成や経路設定は不要です。

**プレースホルダー：**
- \`{app_id}\` — アプリの識別子
- \`{table}\` — スキーマのテーブル名
- \`{id}\` — 行の主キーの値

<span id="data-api"></span>

## データAPI

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\\{app_id}/\\{table} | フィルター、並べ替え、ページ分割付きで行を一覧取得 |
| GET | /v1/\\{app_id}/\\{table}/\\{id} | 主キーで1行取得 |
| POST | /v1/\\{app_id}/\\{table} | 行を作成 |
| PATCH | /v1/\\{app_id}/\\{table}/\\{id} | 行を部分更新 |
| DELETE | /v1/\\{app_id}/\\{table}/\\{id} | 行を削除 |

<span id="filtering"></span>

## フィルター

\`column=operator.value\`形式のクエリパラメーターを追加します。

| 演算子 | 例 | 意味 |
|----------|---------|---------|
| \`eq\` | \`status=eq.published\` | 等しい |
| \`neq\` | \`status=neq.draft\` | 等しくない |
| \`gt\` | \`age=gt.18\` | より大きい |
| \`gte\` | \`age=gte.18\` | 以上 |
| \`lt\` | \`price=lt.100\` | より小さい |
| \`lte\` | \`price=lte.100\` | 以下 |
| \`like\` | \`title=like.%hello%\` | パターン一致（大文字・小文字を区別） |
| \`ilike\` | \`title=ilike.%hello%\` | パターン一致（大文字・小文字を区別しない） |
| \`is\` | \`deleted_at=is.null\` | IS NULL、IS TRUE、IS FALSE |
| \`in\` | \`id=in.(1,2,3)\` | 値のリストに含まれる |
| \`fts\` | \`title=fts.hello world\` | 全文検索（英語、語幹処理あり） |

<span id="sorting"></span>

## 並べ替え

\`order\`パラメーターを使います。

\`\`\`
?order=created_at.desc
?order=name.asc,created_at.desc
\`\`\`

<span id="pagination"></span>

## ページ分割

\`limit\`と\`offset\`を使います。

\`\`\`
?limit=20&offset=40
\`\`\`

41〜60行目を返します。

<span id="column-selection"></span>

## 取得列の指定

\`select\`パラメーターを使います。

\`\`\`
?select=id,title,created_at
\`\`\`

<span id="example"></span>

## 例

\`\`\`
GET /v1/{app_id}/posts?select=id,title,author_id&status=eq.published&order=created_at.desc&limit=20
\`\`\`

<span id="authentication"></span>

## 認証

Authorizationヘッダーからロールを自動判定します。

| リクエストの種類 | Authorizationヘッダー | ロール |
|---|---|---|
| 認証ヘッダーなし | なし | butterbase_anon |
| エンドユーザーJWT | \`Bearer {jwt}\` | butterbase_user |
| プラットフォームAPIキー | \`Bearer {api_key}\` | butterbase_service |

各ロールとデータへのアクセス制御については[行レベルセキュリティ](https://docs.butterbase.ai/ja/core-concepts/row-level-security/)を参照してください。

<span id="schema-endpoints"></span>

## スキーマのエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\\{app_id}/schema | 現在のスキーマを取得 |
| POST | /v1/\\{app_id}/schema/apply | スキーマ更新を適用 |
| GET | /v1/\\{app_id}/migrations | 適用済みマイグレーションを一覧取得 |

<span id="app-management"></span>

## アプリ管理

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /apps | 自分のアプリを一覧取得 |
| POST | /init | アプリを作成（\`region\`は任意） |
| DELETE | /apps/\\{app_id} | アプリを削除 |
| GET | /v1/regions | 対応リージョンを一覧取得（公開、認証不要） |
| POST | /v1/apps/\\{app_id}/move | アプリを別リージョンへ移動 |
| GET | /v1/apps/\\{app_id}/migrations/\\{migration_id} | 移動の進捗を確認 |

リクエストとレスポンスの形は[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)と[プラットフォームAPI](https://docs.butterbase.ai/ja/api-reference/platform-api/#apps--regions)を参照してください。

<span id="health-checks"></span>

## ヘルスチェック

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /health | 生存確認 |
| GET | /health/ready | 準備状態の確認（データベースも検証） |

<span id="error-responses"></span>

## エラーレスポンス

エラーには\`code\`、\`message\`、\`remediation\`を含む構造化オブジェクトが返ります。

\`\`\`json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Table 'nonexistent' does not exist",
    "remediation": "Check the table name and ensure it exists in your schema"
  }
}
\`\`\`

全エンドポイントは[APIリファレンス](https://docs.butterbase.ai/ja/api-reference/data-api/)を参照してください。

---

スキーマにテーブルが存在すると、以下のエンドポイントを自動で利用できます。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\\{app_id}/\\{table} | 行を一覧取得 |
| GET | /v1/\\{app_id}/\\{table}/\\{id} | 1行を取得 |
| POST | /v1/\\{app_id}/\\{table} | 行を作成 |
| PATCH | /v1/\\{app_id}/\\{table}/\\{id} | 行を更新 |
| DELETE | /v1/\\{app_id}/\\{table}/\\{id} | 行を削除 |

<span id="query-parameters"></span>

## クエリパラメーター

<span id="filtering"></span>

### フィルター

形式：\`column=operator.value\`

| 演算子 | 例 | SQL |
|----------|---------|-----|
| \`eq\` | \`status=eq.published\` | \`= 'published'\` |
| \`neq\` | \`status=neq.draft\` | \`!= 'draft'\` |
| \`gt\` | \`age=gt.18\` | \`> 18\` |
| \`gte\` | \`age=gte.18\` | \`>= 18\` |
| \`lt\` | \`price=lt.100\` | \`< 100\` |
| \`lte\` | \`price=lte.100\` | \`<= 100\` |
| \`like\` | \`title=like.%hello%\` | \`LIKE '%hello%'\` |
| \`ilike\` | \`title=ilike.%hello%\` | \`ILIKE '%hello%'\` |
| \`is\` | \`deleted_at=is.null\` | \`IS NULL\` |
| \`in\` | \`id=in.(1,2,3)\` | \`IN (1,2,3)\` |
| \`fts\` | \`title=fts.hello\` | 全文検索 |

<span id="sorting"></span>

### 並べ替え

\`\`\`
?order=created_at.desc
?order=name.asc,created_at.desc
\`\`\`

<span id="pagination"></span>

### ページ分割

\`\`\`
?limit=20&offset=40
\`\`\`

<span id="column-selection"></span>

### 取得列の指定

\`\`\`
?select=id,title,created_at
\`\`\`

<span id="authentication"></span>

## 認証

| 認証方法 | ロール | アクセス範囲 |
|---|---|---|
| なし | butterbase_anon | 公開データのみ |
| エンドユーザーJWT | butterbase_user | ユーザー単位のデータ（RLS） |
| APIキー（\`bb_sk_...\`） | butterbase_service | 全データ（サービス用のアクセス許可） |

<span id="create-a-row"></span>

## 行の作成

\`\`\`bash
POST /v1/{app_id}/posts
Content-Type: application/json
Authorization: Bearer {token}

{
  "title": "Hello World",
  "body": "My first post",
  "published": true
}
\`\`\`

ユーザー分離ポリシーと自動入力トリガーがある場合、\`user_id\`列を自動で設定します。

<span id="update-a-row"></span>

## 行の更新

\`\`\`bash
PATCH /v1/{app_id}/posts/{id}
Content-Type: application/json
Authorization: Bearer {token}

{
  "published": false
}
\`\`\`

変更する列だけを送ってください。

<span id="delete-a-row"></span>

## 行の削除

\`\`\`bash
DELETE /v1/{app_id}/posts/{id}
Authorization: Bearer {token}
\`\`\`

<span id="schema-endpoints"></span>

## スキーマのエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\\{app_id}/schema | 現在のスキーマを取得 |
| POST | /v1/\\{app_id}/schema/apply | スキーマ更新を適用（\`dry_run: true\`で事前確認） |
| GET | /v1/\\{app_id}/migrations | 適用済みマイグレーションを一覧取得 |

<span id="app-management"></span>

## アプリ管理

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /apps | 自分のアプリを一覧取得 |
| POST | /init | アプリを作成。本文：\`{"name": "my-app"}\` |
| DELETE | /apps/\\{app_id} | アプリを完全に削除 |`,
  auth: `エンドユーザーの認証を提供します。app_idごとにアカウントとトークンを分け、データはアプリと同じ[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)へ保存します。

<span id="access-modes"></span>

## アクセスモード

access_modeは匿名リクエストがデータAPIとリアルタイムWebSocketへ到達できるかを制御します。その上でRLSも適用します。

| モード | 動作 |
|------|----------|
| \`public\`（既定） | 匿名を許可。設定済みのRLSは適用。 |
| \`authenticated\` | 匿名のデータ・リアルタイム通信を401拒否。ユーザーJWTとAPIキーだけ許可。 |

関数とストレージは独自の認証規則があり、access_modeの対象外です。

<span id="toggle-access-mode"></span>

### モードを変更

\`\`\`json
PATCH /v1/{app_id}/config/access-mode
Authorization: Bearer {token}

{ "access_mode": "authenticated" }
\`\`\`

レスポンス：

\`\`\`json
{
  "message": "Access mode updated to \\"authenticated\\"",
  "app_id": "app_abc123",
  "access_mode": "authenticated"
}
\`\`\`

<span id="lock-down-in-one-call"></span>

### 1回で保護する

\`POST /v1/{app_id}/secure\`は、authenticatedへの切り替えと、指定テーブルのユーザー分離RLS・自動入力トリガーをまとめて設定します。

\`\`\`json
POST /v1/{app_id}/secure
Authorization: Bearer {token}

{
  "tables": [
    { "table_name": "posts", "user_column": "author_id" },
    { "table_name": "comments", "user_column": "user_id" }
  ]
}
\`\`\`

public_read_columnに真偽列を指定すると、その列がtrueの行の読み取りも許可します。

\`\`\`json
{
  "tables": [
    { "table_name": "posts", "user_column": "author_id", "public_read_column": "is_published" }
  ]
}
\`\`\`

tablesを省くと、RLSは変えずモードだけを切り替えます。

tables_securedとtable_errorsを返します。一部のテーブルや列がなくても、ほかには適用します。

戻すにはモードをpublicへPATCHします。

<span id="signup"></span>

## ユーザー登録

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/signup | 15分に5回 |

\`\`\`json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
\`\`\`

**パスワード要件：** 8文字以上で、大文字、小文字、数字、記号を含むこと。

6桁の確認コードをメールで自動送信します。

<span id="login"></span>

## ログイン

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/login | 15分に10回 |

\`\`\`json
{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!"
}
\`\`\`

**レスポンス：**

\`\`\`json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "email_verified": true,
    "display_name": "Jane Doe",
    "avatar_url": null
  }
}
\`\`\`

APIには**アクセストークン**を送り、期限切れの更新には**リフレッシュトークン**を使います。

<span id="magic-link-sign-in"></span>

## マジックリンクでサインイン

メールで受け取った6桁コードを検証してログインします。パスワードは不要で、新規ユーザーも自動作成します。

**手順1：コード送信**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/magic-link | 15分に5回 |

\`\`\`json
{
  "email": "user@example.com"
}
\`\`\`

メールの登録有無によらず同じ応答を返し、ユーザーの列挙を防ぎます。期限は**15分**です。

**手順2：コード検証**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/magic-link/verify | 15分に10回 |

\`\`\`json
{
  "email": "user@example.com",
  "code": "123456"
}
\`\`\`

loginと同じaccess_token、refresh_token、expires_in、token_type、userを返します。メールを検証済みにし、コードは1回だけ使用できます。

**HTTP 400のエラー：**

| error | 原因 |
|---------|-------|
| \`Invalid sign-in code\` | 不一致 |
| \`Sign-in code already used\` | 使用済み |
| \`Sign-in code expired\` | 15分経過 |

**SDK:**

\`\`\`ts
const { data, error } = await client.auth.sendMagicLink('user@example.com');
// later, after the user enters the code:
const { data, error } = await client.auth.verifyMagicLink('user@example.com', '123456');
\`\`\`

verifyMagicLinkはsignInと同様にセッションを自動保存します。

<span id="behavior-notes"></span>

### 動作の補足

- **新規登録：** 未登録のメールには送信時にユーザーを作成し、初回検証でログイン。
- **isNewUser：** 作成から2分以内の検証を、監査ログと認証後フックで新規ユーザーとして扱う。
- **認証後フック：** event: magic_link_loginとprovider: magic_linkを通知。[フック](https://docs.butterbase.ai/ja/core-concepts/authentication/#post-auth-hooks)を参照。
- **監査イベント：** 送信はmagic_link_requested、検証はmagic_link_login。

<span id="token-refresh"></span>

## トークン更新

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/refresh | 15分に20回 |

新しいアクセストークンへ交換し、古いリフレッシュトークンを無効にします。

\`\`\`json
{
  "refresh_token": "your-refresh-token"
}
\`\`\`

<span id="logout"></span>

## ログアウト

| メソッド | パス | 認証 |
|--------|------|---------------|
| POST | /auth/\\{app_id}/logout | Bearer必須 |

全リフレッシュトークンを失効し、再ログインを要求します。

<span id="email-verification"></span>

## メール検証

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/verify-email | 15分に10回 |

\`\`\`json
{
  "email": "user@example.com",
  "code": "123456"
}
\`\`\`

コードの期限は**24時間**です。

<span id="password-reset"></span>

## パスワードリセット

**手順1：コード要求**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/forgot-password | 15分に3回 |

登録有無によらず成功応答を返します。

**手順2：変更**

| メソッド | パス | レート制限 |
|--------|------|------------|
| POST | /auth/\\{app_id}/reset-password | 15分に5回 |

\`\`\`json
{
  "email": "user@example.com",
  "code": "123456",
  "new_password": "NewP@ssw0rd!"
}
\`\`\`

コードは**1時間**で失効します。既存の全セッションを無効にします。

<span id="social-sign-in-oauth"></span>

## SNSログイン（OAuth）

manage_oauth configureか[設定API](https://docs.butterbase.ai/ja/api-reference/auth-api/)で登録します。

<span id="built-in-providers"></span>

### 組み込みプロバイダー

client_id、client_secret、redirect_urisを渡すと、URLと既定スコープを自動設定します。

| プロバイダー | 既定スコープ |
|----------|---------------|
| **google** | openid, email, profile |
| **github** | user:email |
| **discord** | identify, email |
| **facebook** | email, public_profile |
| **linkedin** | openid, profile, email |
| **microsoft** | openid, email, profile, User.Read |
| **apple** | name、email（provider_metadataが必要） |
| **x** | tweet.read、users.read（メールなし、代替メールを生成） |

独自プロバイダーはauthorization_url、token_url、userinfo_urlも必要です。

<span id="oauth-flow"></span>

### OAuthの流れ

1. \`/auth/{app_id}/oauth/{provider}?redirect_to=https://yourapp.com/callback\`へ誘導。
2. プロバイダーにログイン。
3. コールバックへ戻る。
4. クエリにトークンを返す：\`?access_token=...&refresh_token=...&expires_in=900\`。

<span id="provider-specific-notes"></span>

### プロバイダー固有の補足

- **Google・LinkedIn・Apple：** JWKSでIDトークンから情報を取得。
- **GitHub：** 非公開メールは/user/emailsから自動取得。
- **Apple：** form_postを使用。teamId、keyId、privateKeyのprovider_metadataが必要。名前は初回だけ。
- **X：** PKCEを使用。メールは代替値を生成。

<span id="user-profile"></span>

## ユーザープロフィール

| メソッド | パス | 認証 |
|--------|------|---------------|
| GET | /auth/\\{app_id}/me | 必須 |

現在のユーザー情報を返します。

<span id="token-verification-jwks"></span>

## JWKSでトークン検証

| メソッド | パス | キャッシュ |
|--------|------|-------|
| GET | /auth/\\{app_id}/.well-known/jwks.json | 5分 |

自分のバックエンドで検証する公開鍵を返します。

<span id="using-tokens-with-the-data-api"></span>

## データAPIでトークンを使う

アクセストークンを含めて呼びます。

\`\`\`
GET /v1/{app_id}/posts
Authorization: Bearer {access_token}
\`\`\`

ユーザー分離RLSを有効にすると、自分の行だけが見えます。

<span id="post-auth-hooks"></span>

## 認証後のフック

OAuthログイン、メールログイン、登録の成功後に関数を実行します。fire-and-forgetで、トークン発行を遅らせません。

<span id="configuring"></span>

### 設定

configure_auth_hookかAPIを使います。

\`\`\`json
PATCH /v1/{app_id}/config/auth-hooks
Authorization: Bearer {token}

{
  "post_auth_function": "on-auth"
}
\`\`\`

post_auth_function: nullで解除します。先に対象関数を公開してください。

<span id="hook-payload"></span>

### フックの本文

次のJSONをPOSTします。

\`\`\`json
{
  "event": "oauth_login",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "provider": "google",
    "display_name": "Jane Doe",
    "avatar_url": "https://..."
  },
  "isNewUser": true,
  "provider": "google"
}
\`\`\`

| フィールド | 値 |
|-------|--------|
| \`event\` | \`"oauth_login"\`, \`"signup"\`, \`"login"\` |
| \`isNewUser\` | 初回true、再訪false |
| \`provider\` | google、github、emailなど |

<span id="example-hook-function"></span>

### フックの例

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { event, user, isNewUser } = await req.json();

  if (isNewUser) {
    // Send welcome email
    ctx.waitUntil(
      fetch("https://api.email.com/send", {
        method: "POST",
        body: JSON.stringify({ to: user.email, template: "welcome" }),
      })
    );

    // Sync profile to your own table
    await ctx.db.query(
      "INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)",
      [user.id, user.display_name]
    );
  }

  return new Response("ok");
}
\`\`\`

butterbase_serviceとして実行し、ctx.userはnullです。ユーザーの特定には本文を使います。

<span id="token-lifetimes"></span>

## 有効期間

update_jwt_configでアプリごとに変更します。

- **アクセス：** 既定1h。15m、30m、1h、2h、1dから選択。
- **リフレッシュ：** 既定7日。日単位で変更可能。

SSRのCookieより早くJWTが失効して無応答になるのを避けるため、既定は1時間です。短くする場合はaccess_token_ttl: 15mなどへ変更し、Cookie内のトークンが切れる前にクライアントが更新してください。

---

全認証経路は\`{app_id}\`ごとに分かれ、ユーザーアカウントとトークンもアプリごとに独立しています。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | レート制限 | 用途 |
|--------|------|------------|---------|
| POST | /auth/\\{app_id}/signup | 5回/15分 | ユーザーを登録 |
| POST | /auth/\\{app_id}/login | 10回/15分 | サインイン |
| POST | /auth/\\{app_id}/magic-link | 5回/15分 | 6桁のサインインコードをメール送信 |
| POST | /auth/\\{app_id}/magic-link/verify | 10回/15分 | コードをトークンへ交換 |
| POST | /auth/\\{app_id}/refresh | 20回/15分 | アクセストークンを更新 |
| POST | /auth/\\{app_id}/logout | 認証必須 | セッションを終了 |
| POST | /auth/\\{app_id}/verify-email | 10回/15分 | コードでメールを検証 |
| POST | /auth/\\{app_id}/forgot-password | 3回/15分 | リセットコードを要求 |
| POST | /auth/\\{app_id}/reset-password | 5回/15分 | パスワードをリセット |
| GET | /auth/\\{app_id}/me | 認証必須 | 現在のユーザー情報を取得 |
| GET | /auth/\\{app_id}/.well-known/jwks.json | 5分キャッシュ | トークン検証用の公開鍵 |

<span id="oauth-endpoints"></span>

## OAuthのエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /auth/\\{app_id}/oauth/\\{provider}?redirect_to=\\{url} | OAuthを開始 |
| GET | /auth/\\{app_id}/oauth/\\{provider}/callback | OAuthコールバック |
| POST | /auth/\\{app_id}/oauth/\\{provider}/callback | POSTコールバック（Apple） |

<span id="oauth-configuration"></span>

## OAuthの設定

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/auth/oauth-config | プロバイダーを登録 |
| GET | /v1/\\{app_id}/auth/oauth-config | 全プロバイダーを取得 |
| GET | /v1/\\{app_id}/auth/oauth-config/\\{provider} | 設定を取得 |
| PATCH | /v1/\\{app_id}/auth/oauth-config/\\{provider} | 設定を更新 |
| DELETE | /v1/\\{app_id}/auth/oauth-config/\\{provider} | プロバイダーを削除 |

<span id="register-a-provider"></span>

### プロバイダーの登録

\`\`\`json
POST /v1/{app_id}/auth/oauth-config

{
  "provider": "google",
  "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "client_secret": "YOUR_CLIENT_SECRET",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/google/callback"]
}
\`\`\`

**組み込みプロバイダー**（\`provider\`、\`client_id\`、\`client_secret\`、\`redirect_uris\`だけが必要）：
google, github, discord, facebook, linkedin, microsoft, apple, x

**独自プロバイダー**では\`authorization_url\`、\`token_url\`、\`userinfo_url\`も必要です。

<span id="apple-provider"></span>

### Appleプロバイダー

\`provider_metadata\`が必要です。

\`\`\`json
{
  "provider": "apple",
  "client_id": "com.example.app",
  "client_secret": "placeholder",
  "redirect_uris": ["https://api.example.com/auth/app_yourid/oauth/apple/callback"],
  "provider_metadata": {
    "teamId": "ABCDE12345",
    "keyId": "KEY123",
    "privateKey": "-----BEGIN PRIVATE KEY-----\\n..."
  }
}
\`\`\`

<span id="requestresponse-examples"></span>

## リクエスト・レスポンス例

<span id="signup"></span>

### ユーザー登録

\`\`\`json
POST /auth/{app_id}/signup

{
  "email": "user@example.com",
  "password": "MyP@ssw0rd!",
  "display_name": "Jane Doe"
}
\`\`\`

**パスワード要件：** 8文字以上で、大文字、小文字、数字、記号を含むこと。

<span id="login-response"></span>

### ログインのレスポンス

\`\`\`json
{
  "access_token": "eyJhbGciOi...",
  "refresh_token": "...",
  "expires_in": 3600,
  "token_type": "Bearer",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "email_verified": true,
    "display_name": "Jane Doe",
    "avatar_url": null
  }
}
\`\`\`

<span id="magic-link-send"></span>

### サインインコードの送信

\`\`\`json
POST /auth/{app_id}/magic-link

{ "email": "user@example.com" }
\`\`\`

メールの存在を推測できないよう、登録の有無によらず同じレスポンスを返します。

\`\`\`json
{ "message": "If an account exists with that email, a sign-in code has been sent" }
\`\`\`

コードは**15分**で期限切れになり、1回だけ使えます。初回の検証時に新規ユーザーを自動作成します。

<span id="magic-link-verify"></span>

### サインインコードの検証

\`\`\`json
POST /auth/{app_id}/magic-link/verify

{ "email": "user@example.com", "code": "123456" }
\`\`\`

成功時はログインと同じ形のレスポンスです。失敗はHTTP 400で、\`Invalid sign-in code\`、\`Sign-in code already used\`、\`Sign-in code expired\`のいずれかを返します。

<span id="app-configuration"></span>

## アプリの設定

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\\{app_id}/config | アプリの全設定を取得 |
| PATCH | /v1/\\{app_id}/config/cors | CORSのオリジンを更新 |
| PATCH | /v1/\\{app_id}/config/jwt | トークンの有効期間を更新 |
| PATCH | /v1/\\{app_id}/config/pause | アプリを一時停止・再開。本文：\`{ paused: boolean, reason?: string }\`。停止中のデータプレーンは\`code: APP_PAUSED\`の503を返す。認証とコントロールプレーンは引き続き利用可能。 |

<span id="audit-logs"></span>

## 監査ログ

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/\\{app_id}/audit-logs | 認証イベントを検索。フィルター：\`user_id\`、\`event_type\`、\`limit\`、\`offset\` |`,
  storage: `署名付きURLによるファイルストレージを提供します。ファイルはアプリ・ユーザー単位で整理され、フロントエンドから直接アップロード・ダウンロードします。ファイル本体を自分のバックエンドコードに通す必要はありません。

ストレージはアプリと同じ[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)にあり、ユーザーに近い場所で転送します。

<span id="how-it-works"></span>

## 仕組み

1. **アップロードURLを取得** — ファイル名、コンテンツ種類、サイズを指定して署名付きURLを要求。
2. **直接アップロード** — フロントエンドから署名付きURLへ送信。
3. **ファイルを参照** — 返された\`objectId\`をデータベースへ保存（例：\`image_url\`列）。
4. **必要なときに取得** — objectIdで署名付きダウンロードURLを要求。

<span id="object-id-object-key-and-urls"></span>

## Object ID・オブジェクトキー・URL

| 値 | 内容 | 使い方 |
|--------|------------|---------------------|
| **\`objectId\`** | ファイルを表す固定UUID | **データベースへ保存**し、取得・削除に使用。 |
| **\`objectKey\`** | バケット内のパス | **URLではない。** メタデータとして扱い、表示用に保存しない。 |
| **\`uploadUrl\`／\`downloadUrl\`** | 一時的な署名付きHTTPS URL | **直後**の操作にだけ使用。**期限あり。** |

:::caution
非公開ファイルの恒久的な公開URLは提供しません。表示・取得する際は、新しい署名付きダウンロードURLを発行してください。
:::

<span id="common-mistakes"></span>

## よくある間違い

- **objectKeyをURLとして保存** — パスなので、画像を表示できません。
- **objectKeyをimg srcに指定** — objectIdでダウンロードAPIを呼び、downloadUrlを取得してください。
- **署名付きURLだけを保存** — 期限切れになります。永続的な参照にはobjectIdを保存してください。

<span id="uploading-a-file"></span>

## アップロード

**手順1：** アップロードURLを取得します。

\`\`\`json
POST /storage/{app_id}/upload
Authorization: Bearer {token}

{
  "filename": "profile.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 102400,
  "public": false
}
\`\`\`

\`public: true\`を指定すると、全認証済みユーザーが取得できます。[公開ファイル](https://docs.butterbase.ai/ja/core-concepts/storage/#public-files)を参照してください。

**レスポンス：**

\`\`\`json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
\`\`\`

**手順2：** 署名付きURLでファイルを送信します。

\`\`\`javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
\`\`\`

**手順3：** objectIdをデータベースへ保存します。

<span id="downloading-a-file"></span>

## ダウンロード

\`\`\`json
GET /storage/{app_id}/download/{object_id}
Authorization: Bearer {token}
\`\`\`

**レスポンス：**

\`\`\`json
{
  "downloadUrl": "https://storage.example.com/...",
  "filename": "profile.jpg",
  "expiresIn": 3600
}
\`\`\`

<span id="showing-images-in-the-ui"></span>

## 画面で画像を表示

objectIdを含む行を取得したら、次の順に処理します。

1. 各ファイルのダウンロードAPI、またはSDKの\`getDownloadUrl(objectId)\`を呼ぶ。
2. 返されたdownloadUrlを\`<img src>\`やダウンロードリンクに使う。
3. 一覧では\`Promise.all\`などで**並列**取得して高速化する。

<span id="listing-files"></span>

## ファイル一覧

\`\`\`
GET /storage/{app_id}/objects
Authorization: Bearer {token}
\`\`\`

\`id\`、\`filename\`、\`content_type\`、\`size_bytes\`、\`created_at\`を含むオブジェクト配列を返します。

<span id="storage-limits"></span>

## 制限

| 項目 | 既定値 |
|-------|---------|
| 最大ファイルサイズ | 1ファイル10 MB |
| 合計ストレージ | アプリごとに1 GB |
| 許可するコンテンツ種類 | すべて（設定可能） |

<span id="access-control"></span>

## アクセス制御

- **サービスキー：** 全ファイルにアクセス可能。アップロードをユーザーへ紐付けません。
- **エンドユーザー：** 自分のファイルだけを閲覧・管理。認証済みユーザーへ自動で紐付けます。

<span id="public-files"></span>

## 公開ファイル

既定では非公開で、本人またはサービスキー利用者だけがダウンロードURLを取得できます。公開読み取りの設定は2種類ありますが、どちらも認証済みユーザーが対象です。

<span id="per-object-public-true-at-upload-time"></span>

### ファイル単位：アップロード時の\`public: true\`

アップロード本文に\`public: true\`を指定します。

\`\`\`json
{
  "filename": "post-image.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 204800,
  "public": true
}
\`\`\`

全認証済みユーザーが、アップロードした人によらず\`GET /storage/{app_id}/download/{object_id}\`を呼べます。

<span id="app-wide-publicreadenabled"></span>

### アプリ全体：\`publicReadEnabled\`

アプリ設定を切り替えると、認証済みユーザーが**全ファイル**を読めます。

\`\`\`json
PATCH /v1/{app_id}/config/storage
Authorization: Bearer {token}

{ "publicReadEnabled": true }
\`\`\`

有効にすると次の動作になります。
- 認証済みユーザーがアプリの全ファイルを取得可能
- アップロード・削除はユーザー単位のままで、自分のファイルだけ管理可能
- ファイル単位のpublic指定は不要

<span id="authorization-summary"></span>

### 許可の条件

認証済みの呼び出しで、次の**いずれか**を満たすとURLを発行します。

1. サービスキー（\`bb_sk_...\`）で認証。
2. アプリで\`publicReadEnabled: true\`。
3. ファイルで\`public: true\`。
4. 認証ユーザーがファイルの所有者。

<span id="url-expiration"></span>

## URLの有効期限

- アップロードURL：**5分**
- ダウンロードURL：**1時間**

<span id="sdk-usage"></span>

## SDKでの利用

\`\`\`typescript
const { data } = await butterbase.storage.upload(file);
const { data: url } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);

// Mark a file as publicly downloadable
await butterbase.storage.upload(file, 'avatar.png', { public: true });
\`\`\`

---

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /storage/\\{app_id}/upload | 署名付きアップロードURLを取得 |
| GET | /storage/\\{app_id}/objects | アプリの全ファイルを一覧取得 |
| GET | /storage/\\{app_id}/download/\\{object_id} | 署名付きダウンロードURLを取得 |
| DELETE | /storage/\\{app_id}/\\{object_id} | ファイルを削除 |

<span id="upload"></span>

## アップロード

\`\`\`json
POST /storage/{app_id}/upload
Authorization: Bearer {token}

{
  "filename": "profile.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 102400,
  "public": false
}
\`\`\`

\`public: true\`を指定すると、アップロードした本人以外の認証済みユーザーもダウンロードできます。[公開ファイル](https://docs.butterbase.ai/ja/core-concepts/storage/#public-files)を参照してください。

**レスポンス：**

\`\`\`json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
\`\`\`

続けてファイルをアップロードします。

\`\`\`javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
\`\`\`

<span id="download"></span>

## ダウンロード

\`\`\`json
GET /storage/{app_id}/download/{object_id}
Authorization: Bearer {token}
\`\`\`

**レスポンス：**

\`\`\`json
{
  "downloadUrl": "https://storage.example.com/...",
  "filename": "profile.jpg",
  "expiresIn": 3600
}
\`\`\`

<span id="list-files"></span>

## ファイル一覧

\`\`\`
GET /storage/{app_id}/objects
Authorization: Bearer {token}
\`\`\`

\`{ id, filename, content_type, size_bytes, created_at }\`の配列を返します。

<span id="url-expiration"></span>

## URLの有効期限

| URLの種類 | 有効期限 |
|----------|-----------|
| アップロード | 5分 |
| ダウンロード | 1時間 |

<span id="storage-limits"></span>

## ストレージの制限

| 項目 | 既定値 |
|-------|---------|
| ファイルの最大サイズ | 10 MB |
| 合計ストレージ | アプリごとに1 GB |
| コンテンツ種類 | すべて（設定可能） |

<span id="access-control"></span>

## アクセス制御

| 認証 | アクセス範囲 |
|------|--------|
| サービスキー | 全ファイル。ユーザーへの紐付けなし |
| エンドユーザーJWT | 自分のファイルのみ。自動で紐付け |

<span id="app-wide-storage-configuration"></span>

## アプリ全体のストレージ設定

| メソッド | パス | 用途 |
|--------|------|---------|
| PATCH | /v1/\\{app_id}/config/storage | アプリ全体の公開読み取りを切り替え |

\`\`\`json
PATCH /v1/{app_id}/config/storage
Authorization: Bearer {token}

{ "publicReadEnabled": true }
\`\`\`

**レスポンス：**

\`\`\`json
{
  "message": "Storage configuration updated successfully",
  "app_id": "app_abc123",
  "storage_config": {
    "maxFileSizeMb": 10,
    "allowedContentTypes": ["*/*"],
    "publicReadEnabled": true
  }
}
\`\`\`

\`publicReadEnabled\`が\`true\`の場合、全認証済みユーザーがアプリ内の全ファイルをダウンロードできます。アップロードと削除は引き続きユーザー単位です。`,
  functions: `独自のバックエンド処理をサーバーレス関数としてデプロイできます。TypeScript・JavaScriptを、データベース、環境変数、ネットワークを利用できる隔離されたDeno環境で実行します。

関数はアプリと同じ[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)で動き、データベースとの通信距離を抑えます。

<span id="deploying-a-function"></span>

## 関数のデプロイ

\`\`\`json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\\n    headers: { 'Content-Type': 'application/json' }\\n  });\\n}",
  "description": "A simple greeting function",
  "trigger": {
    "type": "http",
    "config": {}
  }
}
\`\`\`

**必須フィールド：**
- \`name\`：一意の名前（1〜100文字）。
- \`code\`：ハンドラーをデフォルトエクスポートするソースコード。

**任意フィールド：**
- \`description\`：関数の説明。
- \`envVars\`：環境変数のキーと値。保存時に暗号化します。再デプロイ時はマージし、指定したキーを優先します。省略すると維持します。
- \`envVarsReplace\`：trueなら環境変数全体を\`envVars\`へ置換します。既定値はfalse。
- \`timeoutMs\`：実行時間の上限（既定30000、最大300000ミリ秒）。
- \`memoryLimitMb\`：メモリの上限（既定128、64〜1024MB）。
- \`triggers\`：呼び出し方法を指定する配列。単数の\`trigger\`も受け付け、1要素の配列へ変換します。
- \`agent_tool\`：trueなら同じアプリの[エージェント](https://docs.butterbase.ai/ja/core-concepts/agents/)からツールとして呼び出せます。

<span id="trigger-types"></span>

## トリガーの種類

\`triggers\`に指定すると、HTTPと毎日のcronなど、**複数のトリガー**を設定できます。各種類につき1つです。

| 型 | 説明 | 設定 |
|------|-------------|--------|
| \`http\` | HTTPリクエストで実行 | \`{ "method"?, "path"?, "auth"?: "required" \\| "optional" \\| "none" }\` |
| \`cron\` | 定期的に実行 | \`{ "schedule": "*/5 * * * *", "timezone"?: "UTC" }\` |
| \`s3_upload\` | バケットへの保存時に実行 | \`{ "bucket": "name", "prefix"?: "uploads/", "contentTypes"?: ["image/*"] }\` |
| \`webhook\` | 署名付きURLから呼び出し | \`{ "secret_required"?: true, "allowed_sources"?: "github,stripe" }\` |
| \`websocket\` | リアルタイムのフレーム受信時に実行 | \`{}\` |

\`\`\`json
"triggers": [
  { "type": "http", "config": { "auth": "required" } },
  { "type": "cron", "config": { "schedule": "0 9 * * *" } }
]
\`\`\`

<span id="functions-as-agent-tools"></span>

## エージェントのツールとして使う

\`agent_tool: true\`で、同じアプリの[エージェント](https://docs.butterbase.ai/ja/core-concepts/agents/)に公開します。\`agent_tool_description\`をLLMの判断に使い、\`agent_tool_mode\`を適用します。\`read_only\`は承認なしで実行し、\`read_write\`は人の承認を待ちます。

\`\`\`json
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
\`\`\`

グラフ仕様の\`tools.functions\`にも関数名を指定してください。存在しない、または\`agent_tool: true\`でない関数には、ダッシュボードのエディターが警告します。

<span id="writing-functions"></span>

## 関数の書き方

Requestを受け取り、Responseを返します。

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const body = await req.json();

  return new Response(JSON.stringify({ result: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

**関数内で使えるもの：**
- 標準Web API（fetch、Request、Response、Headers、URLなど）。
- \`ctx.env.VAR_NAME\`の環境変数。
- \`ctx.db.query(sql)\`のデータベース。
- \`ctx.user\`のユーザー情報。エンドユーザーJWT、または\`X-Butterbase-As-User\`を指定したサービスキーで設定します。下のサーバー間呼び出しを参照してください。
- \`ctx.caller\`の呼び出し元情報（種類、キーID、スコープ、引き継いだユーザーID）。
- \`ctx.invoke('fn-name', body)\`で同じアプリの関数を呼び出し。認証とユーザー情報を自動で引き継ぎます。
- \`ctx.app\`のアプリ情報と\`ctx.request\`のリクエスト情報。
- \`console.log\`、\`console.info\`、\`console.warn\`、\`console.error\`、\`console.debug\`のログ収集。
- ネットワークへのアクセス。
- \`ctx.idempotency.claim(key)\`のWebhook重複排除。
- \`ctx.waitUntil(promise)\`のバックグラウンド処理。

:::note
関数の環境変数は\`ctx.env\`で取得してください。\`Deno.env.get()\`では取得できません。
:::

<span id="environment-variables"></span>

## 環境変数

次の順序で\`ctx.env\`へマージし、後の値を優先します。

1. **アプリ単位**：全関数で共有します。
2. **関数単位**：\`deploy_function\`の\`envVars\`や\`manage_function.update_env\`で設定し、その関数だけで上書きします。
3. **プラットフォーム**：ランタイムの\`BUTTERBASE_*\`。[コンテキスト](https://docs.butterbase.ai/ja/core-concepts/functions/#platform-context)を参照してください。常に優先します。

アプリ単位の値は全関数で利用できます。関数単位の同名キーはその関数だけで優先します。\`BUTTERBASE_APP_ID\`などのプラットフォームの値は上書きできません。

<span id="app-level"></span>

### アプリ単位

1回設定すると全関数に適用します。

\`\`\`bash
# Via MCP
manage_app({ action: "update_env", app_id, env: { STRIPE_SECRET: "sk_live_…", SENTRY_DSN: "…" } })

# Via HTTP
PATCH /v1/{appId}/env
{ "envVars": { "STRIPE_SECRET": "sk_live_…", "SENTRY_DSN": "…" } }

# Pass value \`null\` to delete a key:
{ "envVars": { "SENTRY_DSN": null } }
\`\`\`

- AES-256-GCMで暗号化して保存します。値は読み出せず、\`GET /v1/{appId}/env\`は\`{ keys, updatedAt }\`だけを返します。
- \`/^BUTTERBASE_/i\`のキーは予約済みで、書き込み時に拒否します。
- 1回の更新で全関数のキャッシュを無効にし、その一覧を返します。各関数の次の実行から適用します。
- ダッシュボードでは**App Settings → Environment variables**。関数の詳細には、継承した値の読み取り専用の一覧と関数単位の編集欄を表示します。

<span id="function-level"></span>

### 関数単位

デプロイ時または後から設定できます。その関数だけで使用します。

\`\`\`bash
# On deploy
deploy_function({ app_id, name, code, envVars: { API_KEY: "…" } })

# Update without redeploying code
manage_function({ action: "update_env", app_id, function_name, env: { API_KEY: "…", OLD_KEY: null } })
\`\`\`

- アプリ単位と同じ暗号化、値の非公開、予約済みプレフィックスの制限があります。
- 同名のアプリ単位の値より優先します。

<span id="precedence-in-code"></span>

### コードでの優先順位

\`\`\`ts
export async function handler(req, ctx) {
  // If STRIPE_SECRET is set at both levels, the function-level value wins.
  const stripe = ctx.env.STRIPE_SECRET;

  // Platform value — always the real app id, even if a user "sets" it at either level (writes are rejected).
  const appId = ctx.env.BUTTERBASE_APP_ID;
}
\`\`\`

<span id="platform-context"></span>

## プラットフォームのコンテキスト

ランタイムが値を設定するため、自分で環境変数として登録する必要はありません。同じ情報を2つの形式で取得できます。

**フラット形式（\`ctx.env.BUTTERBASE_*\`）**：特記がなければ常に存在します。

| キー | 値 |
|-----|-------|
| \`BUTTERBASE_APP_ID\` | アプリID（例：\`app_abc123\`） |
| \`BUTTERBASE_API_URL\` | 公開APIのベースURL |
| \`BUTTERBASE_APP_NAME\` | アプリの表示名 |
| \`BUTTERBASE_REGION\` | 主リージョン（例：\`sjc\`） |
| \`BUTTERBASE_ANON_KEY\` | ブラウザーへ公開できるアプリのanonキー |
| \`BUTTERBASE_FRONTEND_URL\` | フロントエンドのURL。**未デプロイなら省略**。 |
| \`BUTTERBASE_SUBDOMAIN\` | プラットフォームのサブドメイン。未設定なら省略。 |
| \`BUTTERBASE_STRIPE_ACCOUNT_ID\` | 接続したStripeアカウント。課金未設定なら省略。 |
| \`BUTTERBASE_AI_DEFAULT_MODEL\` | \`manage_ai\`の既定モデル。未設定なら省略。 |

任意のキーは空文字列ではなく**省略**します。\`typeof ctx.env.BUTTERBASE_FRONTEND_URL === "string"\`などで確認してください。

**構造化形式（\`ctx.app\`）**：同じ情報を型付きで取得できます。未設定の任意オブジェクトは\`null\`です。

\`\`\`ts
ctx.app = {
  id, name, ownerId, region, subdomain, anonKey, allowedOrigins,
  substrateUserId,                    // substrate user the app is linked to, or null if not linked. ctx.substrate is also null in that case.
  frontend: { url } | null,           // null when no frontend deployed
  auth:     { accessTokenTtl, refreshTokenTtlDays, hookFunction },
  ai:       { defaultModel } | null,  // null when AI config empty
  billing:  { stripeAccountId } | null, // null when billing not connected
}
\`\`\`

**リクエスト単位（\`ctx.request\`）**：受信したヘッダーから作成します。

\`\`\`ts
ctx.request = { id, ip, country, functionName }
\`\`\`

プラットフォームのキーは関数の環境変数の後に設定するため、\`BUTTERBASE_APP_ID\`を独自に指定しても実際の値を上書きしません。

<span id="server-to-server-function-calls"></span>

## サーバー間の関数呼び出し

cronで動く関数から、同じアプリの複数の関数を呼び出せます。
例えば\`auto-sync-google\`から\`ingest-gmail\`と
\`ingest-calendar\`を実行する場合に、次の方法を使います。

<span id="calling-a-durable-object-from-a-function"></span>

### 関数からDurable Objectを呼び出す

\`ctx.invokeDO(className, instanceKey, body?, opts?)\`を使います。
[Durable Objectsのサーバー間呼び出し](https://docs.butterbase.ai/ja/core-concepts/durable-objects/#server-to-server-calls-into-durable-objects)を参照してください。


<span id="ctxinvokefn-name-body--the-easy-path"></span>

### \`ctx.invoke('fn-name', body)\`による呼び出し

同じアプリの関数を、Bearerやキーの環境変数を用意せずに呼び出します。

\`\`\`typescript
export async function handler(req, ctx) {
  // Identity propagates automatically: if this fn was invoked with an
  // end-user JWT, the callee sees the same ctx.user.id.
  const r = await ctx.invoke('ingest-gmail', { workspace_id: 'ws_abc' });
  const data = await r.json();
  return new Response(JSON.stringify({ enqueued: data.queued }), { status: 200 });
}
\`\`\`

動作：
- 自動設定されるアプリの内部関数キーで認証します。このキーは
  \`ctx.env\`には公開しません。
- \`ctx.user.id\`を引き継ぎ、呼び出し先も同じユーザーを認識します。
- 呼び出し先の\`ctx.caller.type\`は\`loopback\`です。
- 循環を防ぐため深さは4までです。5回目の呼び出しで
  \`ctx.invoke loop limit exceeded\`を同期的に投げます。
- \`fetch\`と同じ標準の\`Response\`を返します。

<span id="ctxcaller--who-called-this-function"></span>

### 呼び出し元の\`ctx.caller\`

すべての実行で設定されます。監査ログやアクセス判断に使えるため、
自分で\`req.headers.authorization\`を解析する必要はありません。

\`\`\`ts
ctx.caller = {
  type: 'service_key' | 'end_user_jwt' | 'loopback' | 'anonymous',
  keyId: string | null,  // present iff type === 'service_key'
  scope: string | null,  // first app- or gateway-scope on the key
  userId: string | null, // user this request is acting on behalf of
}
\`\`\`

| 呼び出し元 | type | userId | keyId |
|--------|------|--------|-------|
| ブラウザーのエンドユーザーJWT | \`end_user_jwt\` | JWTの\`sub\` | \`null\` |
| cron・外部サービスの\`bb_sk_*\` | \`service_key\` | \`null\`（代理呼び出し以外） | APIキーの行ID |
| \`ctx.invoke\`で同じアプリの関数 | \`loopback\` | 引き継いだID | \`null\` |
| Bearerなし・無効 | \`anonymous\` | \`null\` | \`null\` |

<span id="x-butterbase-as-user--when-you-have-to-call-from-outside"></span>

### 外部からの\`X-Butterbase-As-User\`

ランタイム外のcron、外部サービス、スクリプトなど、
\`ctx.invoke\`を使えない場合は、アプリに対応する
\`bb_sk_*\`とともにこのヘッダーを送ります。

\`\`\`http
POST /v1/app_abc/fn/ingest-gmail
Authorization: Bearer bb_sk_…
X-Butterbase-As-User: 11111111-2222-3333-4444-555555555555
Content-Type: application/json

{ "workspace_id": "ws_abc" }
\`\`\`

実行前に指定したIDを\`ctx.user.id\`へ設定します。
関数内でBearerの一致を確認する必要はありません。

**関数ごとの制限。** デプロイ時に
\`allow_service_key_impersonation: false\`を指定するか、
\`manage_function action: "update_settings"\`で更新します。
この関数への\`X-Butterbase-As-User\`はエッジで403になります。
エンドユーザーの代理として実行してはいけない管理者専用や
課金Webhookのハンドラーで使ってください。

<span id="anti-pattern-bearer-equality-checks"></span>

### 避けるべきBearerの一致確認

古いテンプレートでは、リクエストのBearerと
\`ctx.env.BUTTERBASE_API_KEY\`の一致で、本文の\`as_user_id\`を
信頼するかを判断していました。

\`\`\`ts
// ❌ Don't do this — fragile under key rotation, multi-key environments,
//    or cloned apps where every function gets a different key.
const expected = \`Bearer \${ctx.env.BUTTERBASE_API_KEY}\`;
if (req.headers.get('authorization') === expected) {
  userId = body.as_user_id;
}
\`\`\`

プラットフォームで認証した\`ctx.user.id\`、または
Bearerを扱わない\`ctx.invoke\`へ変更してください。

<span id="rls-in-functions"></span>

## 関数のRLS

呼び出し方法に対応するロールでRLSポリシーを適用します。

| 呼び出し方法 | ロール | RLS |
|-----------|------|-----|
| エンドユーザーJWT | butterbase_user | ユーザー用ポリシーで自分のデータに制限 |
| プラットフォームAPIキー | butterbase_service | サービス用ポリシーで通常は全行を許可 |
| cronトリガー | butterbase_service | サービス用ポリシーで通常は全行を許可 |

<span id="user-scoped-function"></span>

### ユーザー単位の関数

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  if (!ctx.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Automatically filtered to current user's orders (RLS enforced)
  const orders = await ctx.db.query('SELECT * FROM orders');

  return new Response(JSON.stringify(orders.rows), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

<span id="testing-rls-from-service-functions"></span>

### サービス関数でのRLSテスト

\`ctx.db.asUser()\`と\`ctx.db.asAnon()\`で、特定のロールとしてクエリを実行できます。

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const userId = 'some-user-uuid';

  // Runs as butterbase_user with RLS enforced
  const userPosts = await ctx.db.asUser(userId, async (db) => {
    const result = await db.query('SELECT * FROM posts');
    return result.rows;
  });

  // Runs as butterbase_anon with RLS enforced
  const publicProducts = await ctx.db.asAnon(async (db) => {
    const result = await db.query('SELECT * FROM products');
    return result.rows;
  });

  return new Response(JSON.stringify({ userPosts, publicProducts }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

<span id="using-environment-variables"></span>

## 環境変数の利用

\`\`\`typescript
// Deploy with: envVars: { "API_KEY": "secret123", "BASE_URL": "https://api.example.com" }

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const apiKey = ctx.env.API_KEY;
  const baseUrl = ctx.env.BASE_URL;

  const response = await fetch(\`\${baseUrl}/data\`, {
    headers: { 'Authorization': \`Bearer \${apiKey}\` }
  });

  return new Response(await response.text());
}
\`\`\`

<span id="updating-environment-variables"></span>

### 環境変数の更新

\`PATCH /v1/{app_id}/functions/{name}/env\`で、再デプロイせずに更新できます。

\`\`\`json
PATCH /v1/{app_id}/functions/{name}/env
{
  "envVars": {
    "API_KEY": "new-value",
    "OLD_KEY": null
  }
}
\`\`\`

既存の値へ**マージ**します。全体の置換ではありません。削除するキーは値を\`null\`にします。

<span id="idempotent-webhook-handlers-with-ctxidempotencyclaim"></span>

## ctx.idempotency.claim()によるWebhookの重複排除

Stripe、Telegram、GitHub、Slack、Twilio、Discordなどは、2xx以外の応答で同じイベントIDを再送します。重複を防がなければ、メール送信や課金などを繰り返す原因になります。

\`ctx.idempotency.claim(key)\`は不可分な操作で、初回はtrue、再試行はfalseです。重複した配信には処理を繰り返さず応答できます。

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const event = await req.json();

  // Returns true the first time, false on every retry of the same event.
  if (!(await ctx.idempotency.claim(event.id, { scope: 'stripe' }))) {
    // Already processed — ack the retry without re-running side effects.
    return new Response('duplicate', { status: 200 });
  }

  await processEvent(event);
  return new Response('ok', { status: 200 });
}
\`\`\`

**オプション：**

| オプション | 型 | 既定値 | 用途 |
|---|---|---|---|
| \`scope\` | \`string\` | \`"default"\` | プロバイダーごとに名前空間を分けて競合を防ぎます（\`stripe\`、\`telegram\`、\`github\`など）。 |
| \`ttlSeconds\` | \`number\` | なし | 有効期限を付け、削除してよいキーを判断できます。 |

**保存と削除。** アプリのデータベースの\`_idempotency_keys\`に保存します。自動では削除しないため、日次cronなどで整理してください。

\`\`\`typescript
export default async function handler(_req: Request, ctx: any): Promise<Response> {
  await ctx.db.query("DELETE FROM _idempotency_keys WHERE expires_at < now()");
  return new Response("ok");
}
\`\`\`

**動作：**
- 呼び出し元に関係なく\`butterbase_service\`で実行し、サービス用の権限で重複を確認します。
- キーは255文字までです。超えると例外になります。
- \`INSERT ... ON CONFLICT DO NOTHING\`を使い、同じキーの同時実行でも重複を防ぎます。

<span id="background-work-with-ctxwaituntil"></span>

## ctx.waitUntil()のバックグラウンド処理

\`ctx.waitUntil(promise)\`で、応答した後も処理を続けられます。呼び出し元へはすぐに応答します。

メール送信、外部ログ、外部APIとの同期など、応答の完了を待たせる必要のない処理に使えます。

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const body = await req.json();

  // Schedule background work — continues after response is sent
  ctx.waitUntil(
    fetch("https://api.email.com/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: body.email, subject: "Welcome!" }),
    })
  );

  // You can register multiple waitUntil promises
  ctx.waitUntil(
    ctx.db.query("INSERT INTO activity_log (event) VALUES ($1)", ["user_signup"])
  );

  // Response is returned immediately — background work continues
  return new Response(JSON.stringify({ status: "accepted" }), {
    headers: { "Content-Type": "application/json" }
  });
}
\`\`\`

**動作：**
- 応答後の制限時間は**30秒**です。それを超える処理は中止します。
- Promise内でも\`ctx.db\`を使えます。
- 失敗は応答に影響せず、内部で抑制します。
- \`Promise.allSettled\`と同様に、一部が失敗しても他の登録済み処理を実行します。

<span id="calling-functions-from-your-frontend"></span>

## フロントエンドからの呼び出し

HTTPトリガーの関数は次のURLで利用できます。

\`\`\`
ANY /v1/{app_id}/fn/{function_name}
\`\`\`

任意のHTTPメソッドに対応し、エンドユーザーのトークンを関数へ転送します。

\`\`\`javascript
const response = await fetch(\`\${API_BASE}/v1/\${appId}/fn/hello-world\`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': \`Bearer \${userAccessToken}\`
  },
  body: JSON.stringify({ input: 'data' })
});
\`\`\`

<span id="cron-functions"></span>

## cron関数

標準のcron式を使います。

| 式 | 実行時刻 |
|-----------|----------|
| \`* * * * *\` | 毎分 |
| \`*/5 * * * *\` | 5分ごと |
| \`0 * * * *\` | 毎時 |
| \`0 9 * * *\` | 毎日9時 |
| \`0 0 * * 1\` | 毎週月曜日0時 |

<span id="function-metrics"></span>

## 関数の指標

呼び出しの総数、エラー数と率、平均実行時間、最後の実行日時を記録します。

<span id="invocation-logs"></span>

## 呼び出しログ

HTTPメソッドとパス、応答ステータス、実行時間、メモリ、スタックトレース付きのエラー、\`console.log/info/warn/error/debug\`の\`consoleLogs\`を収集します。

<span id="reading-logs-for-a-deleted-function-forensics"></span>

### 削除済み関数のログの調査

\`manage_function\`の\`get_logs\`は、論理削除した関数に通常404を返します。ログ自体は残っています。調査には\`include_deleted=true\`を指定してください。

\`\`\`bash
butterbase functions logs my-fn --include-deleted
\`\`\`

\`\`\`typescript
await admin.functions.logs('my-fn', { includeDeleted: true });
\`\`\`

\`\`\`http
GET /v1/{app_id}/functions/{name}/logs?include_deleted=true
\`\`\`

所有者の認証が必要です。調査用のログもアプリの所有者だけが取得できます。

<span id="pausing-an-app-kill-switch"></span>

## アプリの一時停止

\`manage_app\`の\`pause\`で、アプリのデータ処理の通信をすべて停止します。Webhookの不具合、cronによる過剰な外部API利用、保守などに使えます。

停止中の動作：
- 関数のHTTP・cron呼び出しは503の\`APP_PAUSED\`。
- CRUD（\`select_rows\`、\`insert_row\`、REST）は503。
- ストレージのアップロード・ダウンロードは503。
- リアルタイムWebSocketは1013（Try again later）で切断。

復旧のため利用できるもの：
- 管理API（アプリ一覧と設定、スキーマ、RLS、環境変数、\`pause\`自体）。
- 認証（ログイン・登録）。運営者が再認証できるよう維持します。

**MCP：**

\`\`\`json
{ "app_id": "app_abc123", "paused": true, "reason": "investigating outbound spam" }
\`\`\`

**CLI：**

\`\`\`bash
butterbase apps pause app_abc123 --reason "investigating outbound spam"
butterbase apps resume app_abc123
\`\`\`

**SDK：**

\`\`\`typescript
await admin.config.pause('investigating outbound spam');
await admin.config.resume();
\`\`\`

停止状態は\`apps\`の列に保存し、Control APIの再起動でも維持します。所有者専用で、\`app.config.paused\`として監査ログに記録します。

---

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/functions | 関数をデプロイまたは更新 |
| GET | /v1/\\{app_id}/functions | 全関数を一覧表示 |
| GET | /v1/\\{app_id}/functions/\\{name} | 関数の詳細と指標を取得 |
| DELETE | /v1/\\{app_id}/functions/\\{name} | 関数を削除 |
| POST | /v1/\\{app_id}/functions/\\{name}/invoke | 関数をテスト実行 |
| GET | /v1/\\{app_id}/functions/\\{name}/logs | 呼び出しログを表示 |

<span id="public-invocation"></span>

## 公開エンドポイントからの呼び出し

| メソッド | パス | 用途 |
|--------|------|---------|
| ANY | /v1/\\{app_id}/fn/\\{function_name} | デプロイ済みの関数を呼び出す（任意のHTTPメソッド） |

エンドユーザーのトークンは関数へ転送されます。

<span id="deploy-a-function"></span>

## 関数のデプロイ

\`\`\`json
POST /v1/{app_id}/functions
Authorization: Bearer {token}

{
  "name": "hello-world",
  "code": "export default async function handler(req) {\\n  return new Response(JSON.stringify({ message: 'Hello!' }), {\\n    headers: { 'Content-Type': 'application/json' }\\n  });\\n}",
  "description": "A simple greeting function",
  "triggers": [
    { "type": "http", "config": { "auth": "required" } },
    { "type": "cron", "config": { "schedule": "0 9 * * *" } }
  ],
  "envVars": {
    "API_KEY": "secret123"
  },
  "timeoutMs": 30000,
  "memoryLimitMb": 128
}
\`\`\`

<span id="required-fields"></span>

### 必須フィールド

| フィールド | 説明 |
|-------|-------------|
| \`name\` | 一意の名前（1〜100文字） |
| \`code\` | ハンドラーをデフォルトエクスポートするソースコード |

<span id="optional-fields"></span>

### 任意フィールド

| フィールド | 既定値 | 説明 |
|-------|---------|-------------|
| \`description\` | — | 関数の説明 |
| \`envVars\` | — | 暗号化して保存する環境変数。実行時にはプラットフォームが\`BUTTERBASE_*\`キーも自動で設定します。[プラットフォームのコンテキスト](https://docs.butterbase.ai/ja/core-concepts/functions/#platform-context)を参照してください。これらは\`envVars\`の後に設定されるため、上書きできません。再デプロイ時は既存の環境変数へマージされ、指定したキーの値が優先されます。省略すると既存の値を維持します。 |
| \`envVarsReplace\` | \`false\` | \`true\`にすると、マージせずに関数の環境変数全体を\`envVars\`で置き換えます。 |
| \`timeoutMs\` | 30000 | 実行時間の上限（最大300000ミリ秒） |
| \`memoryLimitMb\` | 128 | メモリの上限（64〜1024MB） |
| \`triggers\` | \`[{type: "http"}]\` | トリガー設定の配列。各種類につき最大1つです。 |
| \`trigger\` | — | **旧形式**の単一トリガー指定。サーバー側で要素が1つの\`triggers\`配列に変換されます。 |
| \`agent_tool\` | \`false\` | この関数をエージェントのツールとして公開します。 |
| \`agent_tool_description\` | — | LLMに表示する短い説明（最大500文字）。 |
| \`agent_tool_mode\` | \`read_only\` | \`read_only\`または\`read_write\`。\`read_write\`には人による承認（HITL）が必要です。 |
| \`agent_tool_exposed_to\` | \`developer_only\` | \`developer_only\`または\`end_user\`。 |
| \`allow_service_key_impersonation\` | \`true\` | \`true\`の場合、アプリに対応するサービスキーによる\`X-Butterbase-As-User\`を受け付け、指定されたユーザーIDを\`ctx.user.id\`に設定します。管理者専用や課金Webhookのハンドラーでは\`false\`にしてください。この場合、同ヘッダーのあるリクエストはエッジで403になります。[サーバー間の関数呼び出し](https://docs.butterbase.ai/ja/core-concepts/functions/#server-to-server-function-calls)を参照してください。 |

<span id="trigger-types"></span>

### トリガーの種類

トリガーには\`type\`と種類ごとの\`config\`を指定します。1つの関数に設定できるトリガーは各種類につき1つです。重複は一意インデックスで防ぎます。

| 型 | 設定 | 補足 |
|------|--------|-------|
| \`http\` | \`{ method?, path?, auth? }\` | \`auth\`の既定値は\`required\`です。匿名の呼び出しはエッジで401になります。意図的に公開する場合だけ\`none\`を指定してください。 |
| \`cron\` | \`{ schedule, timezone? }\` | \`schedule\`はcron式（例：\`*/5 * * * *\`）。\`timezone\`の既定値はUTCです。 |
| \`s3_upload\` | \`{ bucket, prefix?, contentTypes? }\` | \`prefix\`と、指定した場合はMIMEタイプに一致するオブジェクトがバケットに保存されると実行します。 |
| \`webhook\` | \`{ secret_required?, allowed_sources? }\` | 署名付きWebhook URLを生成します。\`allowed_sources\`はプロバイダーのタグをカンマで区切った一覧です。 |
| \`websocket\` | \`{}\` | リアルタイムチャネルでWebSocketフレームを受信するたびに実行します。 |

<span id="exposing-a-function-as-an-agent-tool"></span>

### 関数をエージェントのツールとして公開する

\`agent_tool: true\`にすると、同じアプリのエージェントがグラフ仕様の\`tools.functions[]\`に関数名を指定して呼び出せます。指定方法は[エージェントAPI](https://docs.butterbase.ai/ja/api-reference/agents-api/)を参照してください。

\`\`\`json
{
  "name": "lookup_account",
  "code": "...",
  "agent_tool": true,
  "agent_tool_description": "Look up a customer by email. Returns id, plan, status.",
  "agent_tool_mode": "read_only",
  "agent_tool_exposed_to": "developer_only"
}
\`\`\`

4つの\`agent_tool*\`フィールドは\`GET /functions\`と\`GET /functions/{name}\`の応答にも含まれるため、クライアントで設定状態を表示できます。

<span id="update-function-settings"></span>

## 関数設定の更新

\`\`\`json
PATCH /v1/{app_id}/functions/{name}/settings
Authorization: Bearer {token}

{
  "allow_service_key_impersonation": false
}
\`\`\`

コードを再デプロイせずに関数ごとの設定を変更できます。現在対応しているのは
\`allow_service_key_impersonation\`だけです。これはフェーズ2の
代理呼び出し制御です。更新が成功するとランタイムのキャッシュが無効になり、
次の呼び出しから新しい値が適用されます。

<span id="update-environment-variables"></span>

## 環境変数の更新

\`\`\`json
PATCH /v1/{app_id}/functions/{name}/env
Authorization: Bearer {token}

{
  "envVars": {
    "API_KEY": "new-secret",
    "NEW_VAR": "value",
    "OLD_VAR": null
  }
}
\`\`\`

値は既存の環境変数に**マージ**されます。全体の置換ではありません。キーを削除するには値を\`null\`にします。

<span id="invocation-logs"></span>

## 呼び出しログ

\`\`\`
GET /v1/{app_id}/functions/{name}/logs?limit=50&since=2026-01-01T00:00:00Z&level=error
\`\`\`

| パラメーター | 説明 |
|-----------|-------------|
| \`limit\` | 取得するログの件数 |
| \`since\` | ISO形式の日付による絞り込み |
| \`level\` | レベルによる絞り込み（\`error\`、\`all\`） |
| \`include_deleted\` | \`true\`にすると論理削除済みの関数のログも取得します（インシデント調査用）。既定値は\`false\`です。 |

<span id="log-entry-fields"></span>

### ログのフィールド

| フィールド | 説明 |
|-------|-------------|
| \`method\` | HTTPメソッド |
| \`path\` | リクエストのパス |
| \`status_code\` | 応答のステータス |
| \`duration_ms\` | 実行時間 |
| \`memory_mb\` | 使用したメモリ |
| \`error\` | エラーメッセージ（ある場合） |
| \`consoleLogs\` | 収集したコンソール出力の配列（\`{ level, message, timestamp }\`） |

<span id="function-metrics"></span>

## 関数の指標

| 指標 | 説明 |
|--------|-------------|
| \`total_invocations\` | 呼び出しの総数 |
| \`error_count\` | エラーの件数 |
| \`error_rate\` | エラー率 |
| \`avg_duration_ms\` | 平均実行時間 |
| \`last_invocation\` | 最後に呼び出した日時 |`,
  frontend: `ローカルでビルドした出力をzipにまとめ、Butterbaseから直接アップロード・デプロイします。Cloudflare PagesのURLで公開されます。

フロントエンドはグローバル配信され、特定の[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)に固定されません。バックエンドの場所にかかわらず、静的ファイルを利用者の近くから届けます。

<span id="how-it-works"></span>

## 仕組み

1. \`create_frontend_deployment\`でデプロイIDとアップロードURLを取得
2. ビルド済みフロントエンドをzipでアップロード
3. \`manage_frontend\`に\`action: "start_deployment"\`を指定して開始
4. \`.pages.dev\`のURLで公開

<span id="supported-frameworks"></span>

## 対応フレームワーク

| フレームワーク | 値 | 備考 |
|-----------|-------|-------|
| React（Vite） | \`react-vite\` | \`npm run build\`で作る\`dist/\` |
| Next.js（静的） | \`nextjs-static\` | \`next build && next export\`で作る\`out/\` |
| 静的HTML | \`static\` | HTML・CSS・JSファイル |
| その他 | \`other\` | 静的出力を作るフレームワーク |

<span id="deploying-via-mcp"></span>

## MCPでデプロイ

**手順1：デプロイを作成**

\`\`\`
create_frontend_deployment({ app_id: "app_abc123", framework: "react-vite" })
\`\`\`

**手順2：zipをアップロード**

\`\`\`bash
curl -X PUT "{uploadUrl}" \\
  -H "Content-Type: application/zip" \\
  --data-binary @frontend.zip
\`\`\`

**手順3：デプロイを開始**

\`\`\`
manage_frontend({ app_id: "app_abc123", action: "start_deployment", deployment_id: "uuid-1234" })
\`\`\`

<span id="deployment-statuses"></span>

## デプロイの状態

| ステータス | 意味 |
|--------|---------|
| \`WAITING\` | 作成済み。zip待ち |
| \`UPLOADING\` | ファイル処理中 |
| \`BUILDING\` | デプロイをビルド中 |
| \`READY\` | 成功。URLを割り当て済み |
| \`ERROR\` | 失敗。エラーメッセージを確認 |
| \`CANCELED\` | 中止済み |

:::note
\`READY\`はCloudflareが受け付けた状態で、エッジへの反映には数分かかる場合があります。更新を案内する前に公開URLへアクセスして確認してください。
:::

<span id="creating-the-zip-file-correctly"></span>

## 正しいzipの作り方

:::caution
Windows Explorerの「圧縮フォルダーに送る」、PowerShellの\`Compress-Archive\`、\`/\`区切りを明示しない\`ZipFile.CreateFromDirectory\`は**使わないでください**。zip内にバックスラッシュのパスができ、Cloudflare Pagesが誤ったMIMEタイプで配信する原因になります。
:::

<span id="recommended-nodejs-archiver"></span>

### 推奨：Node.js archiver

\`\`\`bash
npm install archiver --save-dev
\`\`\`

\`\`\`javascript
// zip-dist.js
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const output = fs.createWriteStream(path.join(__dirname, 'frontend.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(\`frontend.zip created (\${archive.pointer()} bytes)\`);
});

archive.on('error', (err) => { throw err; });
archive.pipe(output);
archive.directory('dist/', false);
archive.finalize();
\`\`\`

<span id="alternative-git-bash--wsl"></span>

### 代替：Git Bash・WSL

\`\`\`bash
cd dist && zip -r ../frontend.zip .
\`\`\`

<span id="environment-variables"></span>

## 環境変数

フロントエンドビルドの環境変数を設定します。

\`\`\`json
PUT /v1/{app_id}/frontend/env

{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "VITE_APP_NAME": "My App"
}
\`\`\`

フレームワークごとの接頭辞：
- **Vite：** \`VITE_\`（例：\`VITE_API_URL\`）
- **Next.js：** \`NEXT_PUBLIC_\`（例：\`NEXT_PUBLIC_API_URL\`）
- **Create React App：** \`REACT_APP_\`（例：\`REACT_APP_API_URL\`）

<span id="spa-routing"></span>

## SPAのルーティング

SPAでは全経路を\`index.html\`へ向ける\`_redirects\`を自動で追加します。クライアント側ルーティングをすぐに利用できます。独自の\`_redirects\`がzipにあれば、その内容を保持します。

<span id="redeployment"></span>

## 再デプロイ

各デプロイはプランの上限まで個別に保持します。不要な古いデプロイは削除してください。

<span id="custom-domains"></span>

## カスタムドメイン

\`*.pages.dev\`の代わりに\`app.example.com\`などの独自ホスト名を使え、SSLは自動発行・更新します。**Launch以上**のプランが必要です。

\`\`\`bash
butterbase domains add app.example.com
butterbase domains status <domain-id>
\`\`\`

DNS、検証方法、ルートドメイン、問題の対処は[カスタムドメイン](https://docs.butterbase.ai/ja/core-concepts/custom-domains/)を参照してください。

<span id="limits"></span>

## 制限

| 項目 | 値 |
|-------|-------|
| デプロイの最大サイズ | 100 MB（圧縮後） |
| アップロードURLの期限 | 15分 |
| アプリごとのデプロイ数 — Playground | 2 |
| アプリごとのデプロイ数 — Launch | 10 |
| アプリごとのデプロイ数 — Certified | 25 |
| アプリごとのデプロイ数 — Enterprise | 無制限 |

---

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/frontend/deployments | デプロイを作成 |
| POST | /v1/\\{app_id}/frontend/deployments/\\{id}/start | デプロイを開始 |
| GET | /v1/\\{app_id}/frontend/deployments | デプロイ履歴を取得 |
| GET | /v1/\\{app_id}/frontend/deployments/\\{id} | デプロイ詳細を取得 |
| POST | /v1/\\{app_id}/frontend/deployments/\\{id}/sync | 状態を強制同期 |
| POST | /v1/\\{app_id}/frontend/deployments/\\{id}/cancel | デプロイを中止 |
| DELETE | /v1/\\{app_id}/frontend/deployments/\\{id} | デプロイを削除 |
| PUT | /v1/\\{app_id}/frontend/env | 環境変数を設定 |
| GET | /v1/\\{app_id}/frontend/env | 環境変数名を一覧取得 |

<span id="create-deployment"></span>

## デプロイの作成

\`\`\`json
POST /v1/{app_id}/frontend/deployments
Authorization: Bearer {token}

{
  "framework": "react-vite"
}
\`\`\`

**レスポンス：**

\`\`\`json
{
  "id": "deployment-uuid",
  "uploadUrl": "https://...",
  "expiresIn": 900,
  "maxSizeBytes": 104857600
}
\`\`\`

<span id="framework-values"></span>

### フレームワークの値

| フレームワーク | 値 |
|-----------|-------|
| React (Vite) | \`react-vite\` |
| Next.js（静的） | \`nextjs-static\` |
| 静的HTML | \`static\` |
| その他 | \`other\` |

<span id="upload-and-start"></span>

## アップロードと開始

**zipをアップロード：**

\`\`\`bash
curl -X PUT "{uploadUrl}" \\
  -H "Content-Type: application/zip" \\
  --data-binary @frontend.zip
\`\`\`

**デプロイを開始：**

\`\`\`
POST /v1/{app_id}/frontend/deployments/{id}/start
\`\`\`

<span id="deployment-statuses"></span>

## デプロイの状態

| ステータス | 意味 |
|--------|---------|
| \`WAITING\` | 作成済み。アップロード待ち |
| \`UPLOADING\` | 処理中 |
| \`BUILDING\` | ビルド中 |
| \`READY\` | 成功 |
| \`ERROR\` | 失敗 |
| \`CANCELED\` | 中止 |

<span id="environment-variables"></span>

## 環境変数

\`\`\`json
PUT /v1/{app_id}/frontend/env

{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "NEXT_PUBLIC_API_KEY": "pk_test_123"
}
\`\`\`

値は保存時に暗号化します。一覧ではキー名だけを返します。

<span id="limits"></span>

## 制限

| 項目 | 値 |
|-------|-------|
| 最大サイズ | 100 MB（圧縮後） |
| アップロードの有効期限 | 15分 |
| Freeプラン | 有効なデプロイ1件 |
| Proプラン | 無制限 |

<span id="custom-domains"></span>

## カスタムドメイン

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/custom-domains | カスタムドメインを追加 |
| GET | /v1/\\{app_id}/custom-domains | 一覧取得 |
| GET | /v1/\\{app_id}/custom-domains/\\{id}/status | 検証状態を確認 |
| POST | /v1/\\{app_id}/custom-domains/\\{id}/verify | 再検証 |
| DELETE | /v1/\\{app_id}/custom-domains/\\{id} | カスタムドメインを削除 |

<span id="add-custom-domain"></span>

### カスタムドメインを追加

\`\`\`json
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{
  "hostname": "app.example.com"
}
\`\`\`

**レスポンス：**

\`\`\`json
{
  "domain": {
    "id": "uuid",
    "hostname": "app.example.com",
    "status": "pending",
    "ssl_status": "pending"
  },
  "cname_target": "butterbase.dev",
  "instructions": "Add a CNAME record..."
}
\`\`\`

レスポンスの\`instructions\`に、DNSプロバイダー向けのCNAME設定手順が入ります。Cloudflare管理のDNSでは、**DNS-only（灰色の雲）**にしてください。異なるCloudflareアカウント間でプロキシを有効にしたCNAME（オレンジの雲）はError 1014になり、動作しません。

<span id="check-status"></span>

### 状態確認

\`\`\`
GET /v1/{app_id}/custom-domains/{id}/status
\`\`\`

Cloudflareの検証状態とSSL状態を返します。ドメイン追加後にポーリングしてください。通常5〜15分で反映します。

<span id="errors"></span>

### エラー

| エラー | 意味 |
|-------|---------|
| \`feature_not_available\` | プランにカスタムドメインがない（Proへの更新が必要） |
| \`RESOURCE_ALREADY_EXISTS\` | ホスト名が登録済み |
| \`RESOURCE_NOT_FOUND\` | ドメインIDが見つからない |`,
  ai: `組み込みのAIゲートウェイを通じ、OpenAI互換APIで大規模言語モデルを呼べます。

<span id="two-ways-to-call-the-gateway"></span>

## 2種類の呼び出し方

- **アプリ単位**（\`/v1/{app_id}/...\`）— 作成済みアプリへ紐付け、呼び出しをそのアプリのログに記録します。既定・許可モデルのアプリ設定を適用します。
- **アプリなし**（\`/v1/...\`）— 汎用ゲートウェイとして利用します。プラットフォームJWTかai:gatewayスコープの個人APIキーで認証し、スクリプト、CLI、OpenAI SDKなどから使えます。

リクエストとレスポンスは同じ形で、パスだけが違います。経路、エラー、個人キーの発行は[AI API](https://docs.butterbase.ai/ja/api-reference/ai-api/)を参照してください。

<span id="how-it-works"></span>

## 仕組み

チャット補完や埋め込みの利用費用を自動追跡し、プランのAIクレジットから消費します。

<span id="chat-completions"></span>

## チャット補完

\`\`\`json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is Butterbase?" }
  ],
  "max_tokens": 500,
  "temperature": 0.7
}
\`\`\`

**ストリーミング：** \`"stream": true\`でSSEを受け取ります。

<span id="multimodal-content"></span>

## マルチモーダル

contentは文字列または型付きコンテンツ部品の配列です。1つのメッセージにテキスト、画像、動画を含められます。

<span id="images"></span>

### 画像

公開URL、またはBase64のdata: URIを渡します。

\`\`\`json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        { "type": "image_url", "image_url": { "url": "https://example.com/photo.jpg" } }
      ]
    }
  ]
}
\`\`\`

モデルが対応する場合、任意のdetailで解像度を指定します（low、high、auto）。

\`\`\`json
{ "type": "image_url", "image_url": { "url": "https://example.com/diagram.png", "detail": "high" } }
\`\`\`

<span id="video"></span>

### 動画

\`\`\`json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Summarise this clip." },
    { "type": "video_url", "video_url": { "url": "https://example.com/clip.mp4" } }
  ]
}
\`\`\`

:::note
対応はモデルによります。anthropic/claude-sonnet-4.6、anthropic/claude-opus-4.6、openai/gpt-4oなどの視覚モデルは画像を受け付けますが、動画は全モデルで使えるわけではありません。テキスト専用モデルに未対応の部品を渡すと、プロバイダーエラーになります。
:::

<span id="multiple-images"></span>

### 複数画像

\`\`\`json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Compare these two screenshots." },
    { "type": "image_url", "image_url": { "url": "https://example.com/before.png" } },
    { "type": "image_url", "image_url": { "url": "https://example.com/after.png" } }
  ]
}
\`\`\`

<span id="using-butterbase-storage-urls"></span>

### Butterbase StorageのURL

保存済み画像は先に署名付きダウンロードURLを取得します。

\`\`\`typescript
const { data } = await butterbase.storage.getDownloadUrl(objectId);

const response = await fetch(\`\${apiUrl}/v1/\${appId}/chat/completions\`, {
  method: 'POST',
  headers: { Authorization: \`Bearer \${token}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'anthropic/claude-sonnet-4.6',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: data.url } },
      ],
    }],
  }),
});
\`\`\`

<span id="embeddings"></span>

## 埋め込み

意味検索、クラスタリングなどに使うベクトルを生成します。

\`\`\`json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
\`\`\`

**一括入力：** 文字列の配列を渡します。

\`\`\`json
{
  "model": "openai/text-embedding-3-small",
  "input": ["first text", "second text", "third text"]
}
\`\`\`

<span id="available-embedding-models"></span>

### 対応する埋め込みモデル

| モデル | ID | 次元数 |
|-------|-----|------------|
| Text Embedding 3 Small | \`openai/text-embedding-3-small\` | 1536 |
| Text Embedding 3 Large | \`openai/text-embedding-3-large\` | 3072 |
| Text Embedding Ada 002 | \`openai/text-embedding-ada-002\` | 1536 |

<span id="video-generation"></span>

## 動画生成

チャットとは違い、動画生成は**非同期**です。30秒から数分かかるため、ジョブを作成して完了まで確認し、MP4を取得します。詳細は[動画生成](https://docs.butterbase.ai/ja/api-reference/ai-api/#video-generation)を参照してください。

動画はトークンではなく呼び出し単位で課金し、最終レスポンスのcharged_credits_usdに実費を返します。

<span id="available-models"></span>

## 利用可能なモデル

先端モデルとオープンモデルを幅広く利用できます。

| モデル | ID |
|-------|-----|
| Claude Sonnet 4.6 | \`anthropic/claude-sonnet-4.6\` |
| Claude Opus 4.6 | \`anthropic/claude-opus-4.6\` |
| Claude Haiku 4.5 | \`anthropic/claude-haiku-4.5\` |
| Claude 3.7 Sonnet | \`anthropic/claude-3.7-sonnet\` |
| Claude 3.7 Sonnet (thinking) | \`anthropic/claude-3.7-sonnet:thinking\` |
| GPT-4o | \`openai/gpt-4o\` |
| GPT-4o Mini | \`openai/gpt-4o-mini\` |
| Llama 3.3 70B | \`meta-llama/llama-3.3-70b-instruct\` |
| DeepSeek R1 | \`deepseek/deepseek-r1\` |
| Gemini 2.5 Flash | \`google/gemini-2.5-flash\` |

最新価格を含む全モデルはダッシュボードの**AI models**で確認するか、認証不要の[\`GET /v1/public/models\`](https://docs.butterbase.ai/ja/api-reference/ai-api/#public-model-catalog)で取得できます。

<span id="ai-configuration"></span>

## AI設定

アプリごとに設定します。

\`\`\`json
PUT /v1/{app_id}/ai/config

{
  "defaultModel": "anthropic/claude-sonnet-4.6",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-sonnet-4.6", "anthropic/claude-haiku-4.5"]
}
\`\`\`

| 設定 | 説明 |
|---------|-------------|
| \`defaultModel\` | 未指定時のモデル |
| \`maxTokensPerRequest\` | 1リクエストの最大トークン（1〜100,000） |
| \`allowedModels\` | 利用可能なモデルを制限 |

<span id="usage-tracking"></span>

## 使用量の追跡

\`\`\`
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
\`\`\`

合計トークン、費用、モデル別内訳を返します。

<span id="using-ai-in-serverless-functions"></span>

## 関数内で利用

BUTTERBASE_APP_IDとBUTTERBASE_API_URLは自動設定します。APIキーだけをenvVarsへ指定してください。

\`\`\`typescript
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { BUTTERBASE_APP_ID, BUTTERBASE_API_URL, BUTTERBASE_API_KEY } = ctx.env;

  const aiResponse = await fetch(\`\${BUTTERBASE_API_URL}/v1/\${BUTTERBASE_APP_ID}/chat/completions\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': \`Bearer \${BUTTERBASE_API_KEY}\`
    },
    body: JSON.stringify({
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'Summarize this text: ...' }],
      max_tokens: 200
    })
  });

  const result = await aiResponse.json();
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' }
  });
}
\`\`\`

<span id="ai-credits"></span>

## AIクレジット

チャット補完と埋め込みは共通残高から消費します。利用枠、追加購入、支出上限、消費順序は[プランと使用量](https://docs.butterbase.ai/ja/core-concepts/plans-and-usage/)を参照してください。

---

Butterbaseは、チャット補完、埋め込み、モデル一覧のOpenAI互換APIを提供します。呼び出し方は2つあります。

- **アプリ単位**：\`/v1/{app_id}/...\`を使います。料金はアプリの所有者に請求し、アプリのAI設定（既定のモデル、許可するモデル）を適用します。
- **ゲートウェイモード**：\`app_id\`なしの\`/v1/...\`を使い、プラットフォームJWTまたは個人APIキーで認証します。アプリを作らずにOpenAI互換ゲートウェイを利用したい場合に使います。

<span id="app-scoped-endpoints"></span>

## アプリ単位のエンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/chat/completions | チャット補完（OpenAI互換） |
| POST | /v1/\\{app_id}/embeddings | 埋め込みを生成 |
| GET | /v1/\\{app_id}/ai/config | AI設定を取得 |
| PUT | /v1/\\{app_id}/ai/config | AI設定を更新 |
| GET | /v1/\\{app_id}/ai/usage | AI使用量を取得 |

<span id="gateway-endpoints-no-app-required"></span>

## ゲートウェイのエンドポイント（アプリ不要）

| メソッド | パス | 用途 | 認証 |
|--------|------|---------|------|
| POST | /v1/chat/completions | チャット補完 | 必須 |
| POST | /v1/embeddings | 埋め込みを生成 | 必須 |
| GET | /v1/models | モデル一覧（OpenAI形式） | 必須 |
| GET | /v1/public/models | 料金付きの公開モデル一覧 | 不要 |

OpenAI SDKの\`baseURL\`を\`https://api.butterbase.ai/v1\`にし、個人APIキーをBearerトークンに指定すると利用できます。リクエストと応答の形式はアプリ単位の場合と同じで、パスだけが異なります。

<span id="chat-completions-gateway"></span>

### チャット補完（ゲートウェイ）

\`\`\`json
POST /v1/chat/completions
Authorization: Bearer bb_sk_...

{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ],
  "max_tokens": 500,
  "temperature": 0.7,
  "stream": false
}
\`\`\`

Server-Sent Eventsを使うには\`"stream": true\`を指定します。

<span id="embeddings-gateway"></span>

### 埋め込み（ゲートウェイ）

\`\`\`json
POST /v1/embeddings
Authorization: Bearer bb_sk_...

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
\`\`\`

<span id="list-models"></span>

### モデル一覧

\`\`\`json
GET /v1/models
Authorization: Bearer bb_sk_...
\`\`\`

応答：

\`\`\`json
{
  "object": "list",
  "data": [
    { "id": "anthropic/claude-3.5-sonnet", "object": "model", "display_name": "Claude 3.5 Sonnet" },
    { "id": "openai/gpt-4o", "object": "model", "display_name": "GPT-4o" }
  ]
}
\`\`\`

<span id="public-model-catalog"></span>

### 公開モデル一覧

**認証なし**で料金とコンテキスト長を含むモデル一覧を取得する専用APIです。ドキュメント、モデル選択画面、ログイン前にモデルを取得するツールなどに使えます。

\`\`\`
GET /v1/public/models
\`\`\`

Authorizationヘッダーは不要です。

応答：

\`\`\`json
{
  "models": [
    {
      "id": "anthropic/claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "inputPricePerMTokens": 3.6,
      "outputPricePerMTokens": 18.0,
      "contextWindow": 200000
    },
    {
      "id": "openai/gpt-4o",
      "name": "GPT-4o",
      "inputPricePerMTokens": 3.0,
      "outputPricePerMTokens": 12.0,
      "contextWindow": 128000
    }
  ]
}
\`\`\`

料金は100万トークンあたりの金額で、モデルを呼び出すときの請求額を表します。コンテキスト長を報告しないモデルでは、\`contextWindow\`が\`null\`の場合があります。

<span id="authentication"></span>

### 認証

プラットフォームJWT（ダッシュボードなどのセッションを使うクライアント）または個人APIキーで認証します。個人キーには\`ai:gateway\`スコープが必要です。[個人APIキー](https://docs.butterbase.ai/ja/api-reference/ai-api/#personal-api-keys)を参照してください。

<span id="errors"></span>

### エラー

エラーはOpenAI互換の形式で返します。

\`\`\`json
{ "error": { "message": "...", "type": "...", "code": "..." } }
\`\`\`

| 状態 | \`error.type\` | \`error.code\` | 発生条件 |
|---|---|---|---|
| 401 | \`authentication_error\` | \`missing_credentials\` | Authorizationヘッダーがありません。 |
| 401 | \`authentication_error\` | \`invalid_api_key\` | トークンが不明、失効済み、または期限切れです。 |
| 403 | \`permission_error\` | \`insufficient_scope\` | APIキーに\`ai:gateway\`スコープがありません。 |
| 402 | \`billing_error\` | \`insufficient_credits\` | 呼び出しに必要な残高がありません。 |
| 404 | \`invalid_request_error\` | \`model_not_found\` | 指定したモデルIDを利用できません。 |
| 400 | \`invalid_request_error\` | \`invalid_request\` | 本文の検証に失敗しました。 |
| 5xx | \`api_error\` | (varies) | プロバイダーの一時的な問題です。間隔を空けて再試行してください。 |

<span id="chat-completions"></span>

## チャット補完

\`\`\`json
POST /v1/{app_id}/chat/completions
Authorization: Bearer {token}

{
  "model": "anthropic/claude-3.5-sonnet",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "max_tokens": 500,
  "temperature": 0.7,
  "stream": false
}
\`\`\`

標準のOpenAI互換の応答形式です。Server-Sent Eventsには\`"stream": true\`を指定します。

<span id="embeddings"></span>

## 埋め込み

\`\`\`json
POST /v1/{app_id}/embeddings
Authorization: Bearer {token}

{
  "model": "openai/text-embedding-3-small",
  "input": "What is Butterbase?",
  "encoding_format": "float"
}
\`\`\`

| パラメーター | 説明 |
|-----------|-------------|
| \`model\` | 埋め込みモデルのID（必須） |
| \`input\` | 文字列または文字列の配列（必須） |
| \`encoding_format\` | \`"float"\`（既定値）または\`"base64"\` |

<span id="available-embedding-models"></span>

### 利用できる埋め込みモデル

| モデル | ID | 次元数 |
|-------|-----|------------|
| Text Embedding 3 Small | \`openai/text-embedding-3-small\` | 1536 |
| Text Embedding 3 Large | \`openai/text-embedding-3-large\` | 3072 |
| Text Embedding Ada 002 | \`openai/text-embedding-ada-002\` | 1536 |

<span id="video-generation"></span>

## 動画生成

動画生成は**非同期**です。ジョブを送信し、状態を確認してから完成したデータをダウンロードします。通常はモデルと長さに応じて30秒から数分かかります。

<span id="endpoints"></span>

### エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/videos/completions | 生成ジョブを送信 |
| GET | /v1/\\{app_id}/videos/completions/\\{job_id} | 状態を確認（終了状態になればダウンロードも処理） |
| GET | /v1/\\{app_id}/videos/completions/\\{job_id}/content?index=N | 生成したMP4を取得 |

<span id="choosing-a-model"></span>

### モデルの選択

動画モデルはチャット・埋め込みモデルとともに\`GET /v1/{app_id}/ai/models\`に含まれます。動画用のプロバイダープレフィックス（例：\`bytedance/seedance-…\`、\`kwaivgi/kling-…\`、\`pixverse/…\`、\`google/veo-…\`）で探してください。動画モデルを\`/chat/completions\`へ送ると、正しいURLを含む\`400 USE_VIDEO_ENDPOINT\`を返します。

<span id="1-submit-a-job"></span>

### 1. ジョブの送信

**curl：**

\`\`\`bash
curl -X POST "https://api.butterbase.ai/v1/$APP_ID/videos/completions" \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "bytedance/seedance-2.0-fast",
    "prompt": "A golden retriever running through sunflowers at sunset, cinematic",
    "duration": 4,
    "resolution": "720p",
    "aspect_ratio": "16:9"
  }'
\`\`\`

**TypeScript（fetch）：**

\`\`\`typescript
const res = await fetch(\`\${BUTTERBASE_API_URL}/v1/\${APP_ID}/videos/completions\`, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${apiKey}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'bytedance/seedance-2.0-fast',
    prompt: 'A golden retriever running through sunflowers at sunset, cinematic',
    duration: 4,
    resolution: '720p',
    aspect_ratio: '16:9',
  }),
});
const job = await res.json();
// { job_id, status: 'pending', polling_url }
\`\`\`

**Python（requests）：**

\`\`\`python
import os, requests
res = requests.post(
    f"{os.environ['BUTTERBASE_API_URL']}/v1/{APP_ID}/videos/completions",
    headers={"Authorization": f"Bearer {os.environ['BUTTERBASE_API_KEY']}"},
    json={
        "model": "bytedance/seedance-2.0-fast",
        "prompt": "A golden retriever running through sunflowers at sunset, cinematic",
        "duration": 4,
        "resolution": "720p",
        "aspect_ratio": "16:9",
    },
)
job = res.json()
# {"job_id": "...", "status": "pending", "polling_url": "..."}
\`\`\`

**応答（202 Accepted）：**

\`\`\`json
{
  "job_id": "5cd4be3e-c65e-4524-97cf-4595a76e2096",
  "status": "pending",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-c65e-4524-97cf-4595a76e2096"
}
\`\`\`

**リクエストのフィールド：**

| フィールド | 必須 | 説明 |
|-------|----------|-------------|
| \`model\` | はい | 動画モデルのID（上記の「モデルの選択」を参照） |
| \`prompt\` | はい | 生成する動画の説明文 |
| \`duration\` | いいえ | 秒単位の長さ。モデルごとに異なります（一般的な値は4、6、8）。 |
| \`resolution\` | いいえ | 例：\`720p\`、\`1080p\`。モデルごとに異なります。 |
| \`aspect_ratio\` | いいえ | 例：\`16:9\`、\`9:16\`、\`1:1\`。モデルごとに異なります。 |
| \`generate_audio\` | いいえ | 真偽値。動画と同時に音声を生成できるモデルで使います。 |
| \`seed\` | いいえ | 生成を再現するための整数。対応しないプロバイダーもあります。 |
| \`input_images\` | いいえ | 画像からの動画生成や最初のフレームの参考に使うHTTPS画像URLの配列 |

<span id="2-poll-for-status"></span>

### 2. 状態の確認

\`polling_url\`を30秒間隔で確認し、\`status\`が終了状態（\`completed\`、\`failed\`、\`cancelled\`、\`expired\`）になるまで続けます。

**curl：**

\`\`\`bash
curl "https://api.butterbase.ai/v1/$APP_ID/videos/completions/$JOB_ID" \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
\`\`\`

**TypeScript：**

\`\`\`typescript
async function poll(jobUrl: string, apiKey: string) {
  while (true) {
    const res = await fetch(jobUrl, { headers: { Authorization: \`Bearer \${apiKey}\` } });
    const job = await res.json();
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 30_000));
  }
}
\`\`\`

**Python：**

\`\`\`python
import time, requests
def poll(job_url, api_key):
    while True:
        job = requests.get(job_url, headers={"Authorization": f"Bearer {api_key}"}).json()
        if job["status"] in {"completed", "failed", "cancelled", "expired"}:
            return job
        time.sleep(30)
\`\`\`

**応答（\`completed\`の場合）：**

\`\`\`json
{
  "job_id": "5cd4be3e-c65e-4524-97cf-4595a76e2096",
  "status": "completed",
  "model": "bytedance/seedance-2.0-fast",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-...",
  "content_urls": [
    "https://api.butterbase.ai/v1/{app_id}/videos/completions/5cd4be3e-.../content?index=0"
  ],
  "error": null,
  "created_at": "2026-05-24T09:59:10.738Z",
  "charged_credits_usd": 0.72576,
  "settled_at": "2026-05-24T10:00:56.769Z"
}
\`\`\`

- 複数の候補を生成するモデルがあるため、\`content_urls\`は配列です。\`?index=N\`で選択します。
- \`charged_credits_usd\`はジョブの確定時（終了状態の最初の確認時）に設定します。待機中・処理中は\`null\`です。
- \`status: "failed"\`の場合、\`error\`にプロバイダーのメッセージを含めます。

<span id="3-download-the-video"></span>

### 3. 動画のダウンロード

\`content_urls\`は絶対URLで、同じBearer APIキーが必要です。\`video/mp4\`のデータをストリームで返します。

**curl：**

\`\`\`bash
curl -L "$CONTENT_URL" \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \\
  --output video.mp4
\`\`\`

**TypeScript：**

\`\`\`typescript
const mp4 = await fetch(job.content_urls[0], { headers: { Authorization: \`Bearer \${apiKey}\` } });
const buf = Buffer.from(await mp4.arrayBuffer());
fs.writeFileSync('video.mp4', buf);
\`\`\`

**Python：**

\`\`\`python
import requests
with requests.get(job["content_urls"][0],
                  headers={"Authorization": f"Bearer {api_key}"}, stream=True) as r:
    with open("video.mp4", "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)
\`\`\`

<span id="error-codes"></span>

### エラーコード

| 状態 | コード | 意味 |
|--------|------|---------|
| 400 | \`USE_VIDEO_ENDPOINT\` | 動画モデルを\`/chat/completions\`へ送信しています。\`/videos/completions\`を使ってください。 |
| 400 | \`INVALID_INDEX\` | \`?index=\`が0以上の整数ではありません。 |
| 402 | \`INSUFFICIENT_CREDITS\` | 残高が組織の利用可能下限未満です。\`balance_usd\`（月間利用枠と追加購入分の合計）、\`credit_floor_usd\`（与信がなければ0）、自動補充の状態を返します。 |
| 403 | \`FORBIDDEN\` | このジョブの作成者ではありません。 |
| 404 | \`MODEL_NOT_FOUND\` | 不明なモデルIDです。 |
| 404 | \`JOB_NOT_FOUND\` | 不明なジョブID、または別のアプリのジョブです。 |
| 409 | \`JOB_NOT_COMPLETED\` | \`completed\`になる前に\`/content\`を呼び出しています。 |
| 502 | \`MODEL_UNAVAILABLE\` | プロバイダーが一時的に利用できません。再試行してください。 |

<span id="jobs-survive-across-polls"></span>

### ジョブの永続化

ジョブは永続化されるため、別のクライアントやプロセスからも確認できます。メモリ内の状態には依存しません。\`polling_url\`を紛失した場合は\`https://api.butterbase.ai/v1/{app_id}/videos/completions/{job_id}\`を使ってください。

完了前に確認をやめると、数分後にクレジットの予約が自動で解除されます。発生したプロバイダーの料金はButterbaseが負担します。後から動画を取得できるとは限らないため、必要なら再送信してください。

<span id="image-generation"></span>

## 画像生成

画像生成も、非同期の送信・確認・ダウンロードで行います。多くのモデルは5〜30秒で完了します。画像専用APIは、\`/chat/completions\`では表せない\`size\`、\`aspect_ratio\`、\`seed\`、\`n\`、参照画像、マスクなどの指定に対応します。

<span id="endpoints-1"></span>

### エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/images/completions | 生成ジョブを送信 |
| GET | /v1/\\{app_id}/images/completions/\\{job_id} | ジョブの状態を確認 |
| GET | /v1/\\{app_id}/images/completions/\\{job_id}/content?index=N | 生成したPNG・JPEGを取得 |

<span id="choosing-a-model-1"></span>

### モデルの選択

画像モデルもチャット・動画とともに\`GET /v1/{app_id}/ai/models\`に含まれます。公開時点の対応モデルは次のとおりです。

| 系列 | モデルID |
|--------|-----------|
| OpenAI | \`openai/gpt-image-2\`, \`openai/gpt-image-1\`, \`openai/gpt-image-1-mini\` |
| Google (Nano Banana) | \`google/gemini-3-pro-image-preview\`, \`google/gemini-3.1-flash-image-preview\`, \`google/gemini-2.5-flash-image\` |
| ByteDance Seedream | \`bytedance/seedream-5-pro\`, \`bytedance/seedream-5-lite\`, \`bytedance/seedream-4-5\` |
| Alibaba Wan | \`alibaba/wan-2.7-image-pro\`, \`alibaba/wan-2.7-image\`, \`alibaba/wan-2.6-t2i\`, \`alibaba/wan-2.6-image\` |
| PrunaAI | \`prunaai/p-image\`, \`prunaai/p-image-edit\` |

使えるパラメーターは**モデルごとに異なります**。未対応の指定は無視せず、対応する全パラメーターを含む\`400 UNSUPPORTED_PARAM\`を返します。

<span id="1-submit-a-job-1"></span>

### 1. ジョブの送信

**curl：**

\`\`\`bash
curl -X POST "https://api.butterbase.ai/v1/$APP_ID/images/completions" \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "openai/gpt-image-2",
    "prompt": "A serene mountain lake at sunset, photorealistic",
    "size": "1024x1024",
    "n": 1
  }'
\`\`\`

**TypeScript（fetch）：**

\`\`\`typescript
const res = await fetch(\`\${BUTTERBASE_API_URL}/v1/\${APP_ID}/images/completions\`, {
  method: 'POST',
  headers: {
    'Authorization': \`Bearer \${apiKey}\`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'google/gemini-3-pro-image-preview',
    prompt: 'A serene mountain lake at sunset, photorealistic',
    aspect_ratio: '16:9',
  }),
});
const job = await res.json();
// { job_id, status: 'pending', polling_url }
\`\`\`

**Python（requests）：**

\`\`\`python
import os, requests
res = requests.post(
    f"{os.environ['BUTTERBASE_API_URL']}/v1/{APP_ID}/images/completions",
    headers={"Authorization": f"Bearer {os.environ['BUTTERBASE_API_KEY']}"},
    json={
        "model": "alibaba/wan-2.7-image-pro",
        "prompt": "A cat wearing a spacesuit",
        "size": "2K",
        "seed": 42,
    },
)
job = res.json()
# {"job_id": "...", "status": "pending", "polling_url": "..."}
\`\`\`

**応答（202 Accepted）：**

\`\`\`json
{
  "job_id": "0776b4a1-aef9-4fbc-8ac6-18255aa18614",
  "status": "pending",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/images/completions/0776b4a1-aef9-4fbc-8ac6-18255aa18614"
}
\`\`\`

**リクエストのフィールド：**

| フィールド | 必須 | 説明 |
|-------|----------|-------------|
| \`model\` | はい | 画像モデルのID（上の表を参照） |
| \`prompt\` | はい | 生成する画像の説明文 |
| \`size\` | いいえ | 例：\`1024x1024\`、\`1536x1024\`、\`1K\`、\`2K\`、\`4K\`。モデルごとに異なります。 |
| \`aspect_ratio\` | いいえ | 例：\`16:9\`、\`1:1\`。GeminiとPrunaのみ。 |
| \`n\` | いいえ | 生成枚数。GPT Image 2・1・1-miniのみ。 |
| \`seed\` | いいえ | 生成を再現するための整数。Wan、Pruna、GPT Image 2、一部のOpenRouterモデルに対応。 |
| \`input_images\` | いいえ | 変換や参照に使うHTTPS画像URLの配列（多くのモデルで最大14件） |
| \`mask\` | いいえ | 編集用アルファマスクのHTTPS URL。GPT Image 2のみ。 |
| \`negative_prompt\` | いいえ | 生成で避けたい内容の説明文。Wan 2.6のみ。 |
| \`provider\` | いいえ | モデル固有の設定（Wanの\`bbox_list\`・\`color_palette\`、GPTの\`quality\`・\`background\`、Seedreamの\`optimize_prompt_options\`など）。モデルが対応する設定の一覧で検証します。 |

**画像URLの別名：** トップレベルの\`image\`、\`image_url\`、\`image_uri\`、\`reference_image\`、\`input_image\`、\`starting_image\`は、検証前に\`input_images[]\`へまとめます。\`mask\`は独立したトップレベルのフィールドです。

<span id="2-poll-for-status-1"></span>

### 2. 状態の確認

\`polling_url\`を2〜5秒間隔で確認し、\`status\`が終了状態（\`completed\`、\`failed\`、\`cancelled\`、\`expired\`）になるまで続けます。

**curl：**

\`\`\`bash
curl "https://api.butterbase.ai/v1/$APP_ID/images/completions/$JOB_ID" \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY"
\`\`\`

**TypeScript：**

\`\`\`typescript
async function poll(jobUrl: string, apiKey: string) {
  while (true) {
    const res = await fetch(jobUrl, { headers: { Authorization: \`Bearer \${apiKey}\` } });
    const job = await res.json();
    if (['completed', 'failed', 'cancelled', 'expired'].includes(job.status)) return job;
    await new Promise(r => setTimeout(r, 2_000));
  }
}
\`\`\`

**Python：**

\`\`\`python
import time, requests
def poll(job_url, api_key):
    while True:
        job = requests.get(job_url, headers={"Authorization": f"Bearer {api_key}"}).json()
        if job["status"] in {"completed", "failed", "cancelled", "expired"}:
            return job
        time.sleep(2)
\`\`\`

**応答（\`completed\`の場合）：**

\`\`\`json
{
  "job_id": "0776b4a1-aef9-4fbc-8ac6-18255aa18614",
  "status": "completed",
  "model": "openai/gpt-image-2",
  "polling_url": "https://api.butterbase.ai/v1/{app_id}/images/completions/0776b4a1-...",
  "content_urls": [
    "https://api.butterbase.ai/v1/{app_id}/images/completions/0776b4a1-.../content?index=0"
  ],
  "error": null,
  "created_at": "2026-07-15T02:57:44.271Z",
  "charged_credits_usd": 0.010168,
  "settled_at": "2026-07-15T02:58:04.512Z"
}
\`\`\`

- \`content_urls\`は配列です。GPT Imageで\`n > 1\`の場合、生成画像ごとに1件を含めます。
- \`charged_credits_usd\`はジョブの確定時（終了状態の最初の確認時）に設定します。待機中・処理中は\`null\`です。
- \`status: "failed"\`の場合、\`error\`にプロバイダーのメッセージを含めます。

<span id="3-download-the-image"></span>

### 3. 画像のダウンロード

\`content_urls\`は絶対URLで、同じBearer APIキーが必要です。PNGまたはJPEGのデータを返します。形式はモデルやリクエストで異なるため、\`Content-Type\`を確認してください。

**curl：**

\`\`\`bash
curl -L "$CONTENT_URL" \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \\
  --output image.png
\`\`\`

**TypeScript：**

\`\`\`typescript
const img = await fetch(job.content_urls[0], { headers: { Authorization: \`Bearer \${apiKey}\` } });
const buf = Buffer.from(await img.arrayBuffer());
// Content-Type header tells you the format: image/png, image/jpeg, image/webp
\`\`\`

<span id="errors-1"></span>

### エラー

動画生成と同じ分類に加え、画像用のエラーコードがあります。

| 状態 | コード | 意味 |
|--------|------|---------|
| 400 | \`UNSUPPORTED_PARAM\` | モデルが対応しない設定です。本文に\`supported_top_level\`と\`supported_provider\`を返します。 |
| 400 | \`WRONG_MODALITY\` | 画像モデルではありません（チャット・動画モデルなど）。 |
| 402 | \`INSUFFICIENT_CREDITS\` | アプリのクレジットが不足しています。 |
| 404 | \`JOB_NOT_FOUND\` | jobIdがないか、別のエンドユーザーのジョブです。 |
| 409 | \`JOB_NOT_COMPLETED\` | 終了状態になる前に\`/content\`を呼び出しています。 |
| 502 | \`MODEL_UNAVAILABLE\` | プロバイダーが一時的に利用できません。再試行してください。 |

<span id="notes-on-url-expiration"></span>

### URLの有効期限

コンテンツURLはプロバイダーのストレージを指し、通常は生成から**約30日**で失効します。長く保存する場合は、期限内に画像をダウンロードし、自分のバケット（Butterbase Storageなど）へ保存してください。

<span id="concurrency"></span>

### 同時実行

Butterbase側にはアプリ・キーごとの同時実行数の上限はありません。クレジット残高の範囲で並行してPOSTし、返された\`job_id\`を個別に確認できます。モデルのプロバイダーのレート制限に達すると、そのエラーを含む429を返します。

<span id="configuration"></span>

## 設定

\`\`\`json
PUT /v1/{app_id}/ai/config

{
  "defaultModel": "anthropic/claude-3.5-sonnet",
  "maxTokensPerRequest": 4096,
  "allowedModels": ["anthropic/claude-3.5-sonnet"]
}
\`\`\`

| フィールド | 説明 |
|-------|-------------|
| \`defaultModel\` | モデルを省略した場合に使うモデル |
| \`maxTokensPerRequest\` | リクエストあたりのトークン上限（1〜100,000） |
| \`allowedModels\` | 利用できるモデルを制限 |

<span id="usage"></span>

## 使用量

\`\`\`
GET /v1/{app_id}/ai/usage?startDate=2026-01-01&endDate=2026-01-31
\`\`\`

**応答：**

\`\`\`json
{
  "totalTokens": 150000,
  "totalCost": 0.45,
  "byModel": {
    "anthropic/claude-3.5-sonnet": {
      "tokens": 120000,
      "cost": 0.40,
      "requests": 25
    }
  }
}
\`\`\`

<span id="personal-api-keys"></span>

## 個人APIキー

スクリプト、CLI、OpenAI SDKなど、ダッシュボード外からゲートウェイを使うには、\`ai:gateway\`スコープの個人APIキーを発行します。

\`\`\`json
POST /api-keys
Authorization: Bearer {jwt}

{
  "name": "my-cli",
  "scopes": ["ai:gateway"]
}
\`\`\`

平文のキーは応答で1回だけ返します。すぐに保存してください。以降はプレフィックスだけを表示します。

<span id="scopes"></span>

### スコープ

| スコープ | 権限 |
|---|---|
| \`*\` | ユーザーが利用できるすべてのButterbase API |
| \`ai:gateway\` | \`POST /v1/chat/completions\`、\`POST /v1/embeddings\`、\`GET /v1/models\`だけを利用可能 |

ダッシュボードの\`/api-keys\`で一覧と失効の操作ができます。\`ai:gateway\`を指定するには、\`POST /api-keys\`を直接呼び出します。

<span id="meeting-bots"></span>

## 会議ボット

\`ctx.ai.meetings\`でZoom、Google Meet、Microsoft Teams、Webexへ参加し、録画と文字起こしを行うボットを起動できます。REST APIまたはSDKで開始し、会議終了と成果物の準備をWebhookで確認します。料金はAIクレジットから差し引きます。以下のサンプルは元の英語ページにある旧仕様です。現在のアプリ単位のパス、応答コード、署名検証は[AI会議API](https://docs.butterbase.ai/ja/api-reference/ai-meetings-api/)を参照してください。

<span id="endpoints-2"></span>

### エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/ai/meetings | ボットを起動（旧パス） |
| GET | /v1/ai/meetings/\\{bot_id} | ボットの状態と成果物のURLを取得（旧パス） |
| DELETE | /v1/ai/meetings/\\{bot_id} | ボットを停止（旧パス） |
| GET | /v1/ai/meetings | ボット一覧を取得（旧パス） |
| GET | /v1/ai/meetings/_estimate | 料金を見積もる（旧パス） |

<span id="start-a-bot"></span>

### ボットの起動

**リクエスト：**

\`\`\`json
POST /v1/ai/meetings
Authorization: Bearer bb_sk_...

{
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "transcript": true,
  "recording": "mp4",
  "metadata": {
    "dealId": "d_42"
  }
}
\`\`\`

**リクエストのフィールド：**

| フィールド | 型 | 必須 | 既定値 | 説明 |
|-------|------|----------|---------|-------------|
| \`meetingUrl\` | string | はい | — | 参加する会議の完全なURL |
| \`transcript\` | boolean | いいえ | \`true\` | 文字起こしを生成するかどうか |
| \`recording\` | \`"mp4" \\| "audio_only" \\| false\` | いいえ | \`"mp4"\` | 録画形式。\`false\`なら録画しません。 |
| \`metadata\` | \`Record<string, string>\` | いいえ | \`{}\` | 任意のキーと値。\`bb_\`で始まるキーは予約済みで、400になります。 |

**応答（201 Created、旧仕様）：**

\`\`\`json
{
  "id": "bot_01j9...",
  "status": "joining",
  "startedAt": null,
  "completedAt": null,
  "durationSeconds": null,
  "recordingUrl": null,
  "transcriptUrl": null,
  "metadata": {
    "dealId": "d_42"
  }
}
\`\`\`

ボットを返す各エンドポイントで\`MeetingBot\`の形式は共通です。

<span id="bot-status-lifecycle"></span>

### ボットの状態

ボットは次の状態を経て進行します。

| 状態 | 意味 |
|--------|---------|
| \`joining\` | 会議に接続中 |
| \`waiting_room\` | 待機室で許可待ち |
| \`in_call\` | 会議に参加済み |
| \`recording\` | 録画中（有効なら文字起こしも実行） |
| \`ended\` | 会議が終了し、成果物を処理中 |
| \`done\` | 成果物を取得可能。\`recordingUrl\`と、該当する場合は\`transcriptUrl\`を設定。 |
| \`fatal\` | 復旧できないエラー。状態と\`bot.fatal\`のWebhookを確認。 |

<span id="sdk-usage"></span>

### SDKの使用例

\`\`\`ts
import { butterbase } from '@butterbase/sdk';

const bb = butterbase({ apiKey: '...', appId: '...' });

// Start a bot
const { data: bot, error } = await bb.ai.meetings.start({
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  transcript: true,
  recording: 'mp4',
  metadata: { dealId: 'd_42' },
});

// Later, after the webhook tells you the bot is done:
const { data: finished } = await bb.ai.meetings.get(bot!.id);
// finished.recordingUrl + finished.transcriptUrl are now populated
\`\`\`

その他のSDKメソッド：

\`\`\`ts
// Stop a bot early
await bb.ai.meetings.stop(bot!.id);

// List bots with optional filters
const { data: bots } = await bb.ai.meetings.list({ status: 'done', limit: 20, cursor: '...' });

// Estimate cost before dispatching
const { data: estimate } = await bb.ai.meetings.estimateCost({ durationMinutes: 60, transcript: true });
// estimate.usd — projected total charge
\`\`\`

<span id="pricing"></span>

### 料金

元のページの料金例は、録画が**1時間あたり0.50米ドル＋上乗せ料金**、文字起こしが**1時間あたり0.15米ドル＋上乗せ料金**で、いずれも秒単位の按分です。\`done\`になったときにAIクレジットから差し引きます。実際の環境の料金は見積もりAPIで確認してください。

現在の見積もりAPIは\`GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes=N&transcript=true\`です。起動前に確認できます。

<span id="webhook-events"></span>

### Webhookイベント

\`manage_ai\`の\`configure_meetings_webhook\`で設定したURLにイベントを転送します。Butterbaseが転送前に署名を付けます。

**イベントの種類：**

| イベント | 発生条件 |
|-------|---------------|
| \`bot.in_call_recording\` | 入室が許可され、録画を開始 |
| \`bot.done\` | ボットが退出し、録画を取得可能 |
| \`bot.fatal\` | ボットの失敗。状態を確認 |
| \`recording.done\` | 録画をダウンロード可能 |
| \`transcript.done\` | 文字起こしをダウンロード可能 |
| \`transcript.failed\` | 文字起こしに失敗 |

**本文の形式：**

\`\`\`json
POST <your-forward-url>
Content-Type: application/json
x-bb-event: bot.done
x-bb-signature: v1,<base64>
x-bb-key-id: <16-char identifier>

{
  "event": "bot.done",
  "data": { /* event-specific payload */ }
}
\`\`\`

<span id="signature--freshness"></span>

### 署名と重複の確認

現在の署名方式は、アプリごとのシークレットによるHMAC-SHA256です。受信した本文の生バイト列から署名を計算し、\`x-bb-signature\`と定数時間で比較してください。\`x-bb-key-id\`の一致だけでは署名の検証にはなりません。[AI会議APIの署名検証](https://docs.butterbase.ai/ja/api-reference/ai-meetings-api/#verifying-the-signature)に計算式を掲載しています。

**重複配信でデータベースへの書き込みや外部呼び出しを繰り返さないでください。** 本文の\`bot.id\`とイベント名を組み合わせて冪等キーにします。プロバイダーの配信サービスは最大24時間再試行する場合があります。

<span id="limits"></span>

### 制約

- **単一リージョン。** v1のボットは米国東部のワークスペースから起動します。複数リージョンへのルーティングは計画中です。
- **会議時間の固定上限なし。** 会議が終了するかAIクレジット残高が尽きるまで動作します。
- **成果物の保存期間。** 元のページでは終了後7日間です。期限までに録画と文字起こしをダウンロードしてください。`,
  meetings: `ctx.ai.meetings、またはSDKのbb.ai.meetingsで会議URLを渡すと、ボットが参加し、終了後に録画と文字起こしを返します。チャットや埋め込みと同様にAIクレジットから消費します。

<span id="when-to-use-it"></span>

## 用途

- 会議の記録と要約
- 営業会議の文字起こしとフォローアップ作成
- 顧客会議の社内記録
- 外部会議の音声、動画、文字起こしが必要な機能

<span id="how-it-works"></span>

## 仕組み

1. 会議URLで\`POST /v1/{app_id}/ai/meetings\`を呼ぶと、ボットを作成してidとstatusを即時返し、残高から少額を仮確保。
2. ボットが参加。joining → waiting_room → in_call → recording → ended → doneをWebhookで通知し、GETでも確認可能。
3. 終了後に録画と文字起こしを作成。実測時間で費用を確定し、仮確保の未使用分を自動返金。
4. 成果物の準備ができると、登録WebhookへIDだけを通知。ボットをGETするとrecordingUrlとtranscriptUrlが入るため、そこから取得。

<span id="controlling-when-the-bot-gives-up"></span>

## 自動退出の時間

既定ではプロバイダーの自動退出設定に従い、待機室や無人の部屋でしばらく待ちます。作成時のautomaticLeaveで個別に変更でき、各項目は任意の正の秒数です。省略項目はプロバイダーの既定値を使います。

| 項目 | 退出する条件 |
|---|---|
| \`waitingRoomTimeoutSec\` | 入室許可を得られず待機室で指定秒数が経過。 |
| \`noOneJoinedTimeoutSec\` | 誰も参加しないまま指定秒数が経過。 |
| \`everyoneLeftTimeoutSec\` | 全員退出し、無人のまま指定秒数が経過。 |
| \`inCallNotRecordingTimeoutSec\` | 同意拒否などで録画しないまま指定秒数が経過。 |

**例：15分で入室できなければ退出：**

\`\`\`ts
await bb.ai.meetings.start({
  meetingUrl,
  automaticLeave: { waitingRoomTimeoutSec: 900 },
});
\`\`\`

HTTPの形は[AI会議API](https://docs.butterbase.ai/ja/api-reference/ai-meetings-api/#auto-leave-timers)を参照してください。

<span id="configuring-webhooks"></span>

## Webhookの設定

アプリごとに転送URLとHMACシークレットを登録します。イベントをそのアプリのキーで署名し、Stripe・GitHub・Recall.aiと同様のHMAC-SHA256で検証します。

\`\`\`bash
curl -X PUT https://api.butterbase.ai/v1/{app_id}/ai/meetings/webhook \\
  -H "authorization: Bearer bb_sk_..." \\
  -H "content-type: application/json" \\
  -d '{
    "forward_url": "https://your-app.example.com/recall/events",
    "rotate_secret": true
  }'
\`\`\`

レスポンス（secretだけは機密です。再取得できないため、画面を離れる前に安全に保存してください）：

\`\`\`json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://your-app.example.com/recall/events",
  "secret": "wsec_..."
}
\`\`\`

既定のイベント：

- bot.in_call_recording — 参加・録画開始
- bot.done — 正常終了
- bot.fatal — エラー終了
- recording.done — 録画の準備完了
- transcript.done — 文字起こし完了
- transcript.failed — 文字起こし失敗

<span id="verifying-a-forwarded-event"></span>

## 転送イベントを検証

\`\`\`ts
// node or deno function
const expected = 'v1,' + crypto
  .createHmac('sha256', Buffer.from(ctx.env.MEETINGS_WEBHOOK_SECRET, 'utf8'))
  .update(rawBody)
  .digest('base64');

if (!timingSafeEqual(expected, req.headers.get('x-bb-signature'))) {
  return new Response('invalid signature', { status: 401 });
}
\`\`\`

PUTで返されたwsec_...を使います。AES-256-GCMで保存し、平文はアプリとプラットフォームだけが扱います。

<span id="pricing"></span>

## 料金

録画は1時間0.50ドル、文字起こしは1時間0.15ドルで、[AI連携](https://docs.butterbase.ai/ja/core-concepts/ai-integration/)のクレジットから消費します。最初に数セント程度を仮確保し、確定時に未使用分を返金します。

\`GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes=30\`で時間に応じた見積もりを取得します。

<span id="complete-worked-example"></span>

## 完全な実装例

受け取った会議URLを記録し、管理用の情報を保存し、Webhookから録画・文字起こしURLを補う最小アプリです。

<span id="schema"></span>

### スキーマ

\`\`\`json
{
  "tables": {
    "meetings": {
      "columns": {
        "id":             { "type": "uuid", "primaryKey": true, "default": "gen_random_uuid()" },
        "bot_id":         { "type": "text", "nullable": false, "unique": true },
        "meeting_url":    { "type": "text", "nullable": false },
        "status":         { "type": "text", "nullable": false, "default": "'pending'" },
        "last_event":     { "type": "text" },
        "events_count":   { "type": "integer", "nullable": false, "default": "0" },
        "recording_url":  { "type": "text" },
        "transcript_url": { "type": "text" },
        "created_at":     { "type": "timestamptz", "nullable": false, "default": "now()" }
      },
      "indexes": { "meetings_bot_id_idx": { "columns": ["bot_id"], "unique": true } }
    }
  }
}
\`\`\`

<span id="spawn-function-post-fnspawn-bot"></span>

### 作成用関数（POST /fn/spawn-bot）

\`\`\`ts
export default async function handler(req: Request, ctx: any): Promise<Response> {
  const { meetingUrl } = await req.json();
  const res = await fetch(
    \`\${ctx.env.BUTTERBASE_API_URL}/v1/\${ctx.env.BUTTERBASE_APP_ID}/ai/meetings\`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: \`Bearer \${ctx.env.BUTTERBASE_API_KEY}\`,
      },
      body: JSON.stringify({ meetingUrl, transcript: true, recording: 'mp4' }),
    },
  );
  const bot = await res.json();
  if (!res.ok) return new Response(JSON.stringify(bot), { status: 502 });

  await ctx.db.query(
    'INSERT INTO meetings (bot_id, meeting_url, status, last_event) VALUES ($1, $2, $3, $4)',
    [bot.id, meetingUrl, bot.status ?? 'joining', 'spawn'],
  );
  return new Response(JSON.stringify({ bot_id: bot.id, status: bot.status }), {
    headers: { 'content-type': 'application/json' },
  });
}
\`\`\`

\`envVars: { BUTTERBASE_API_KEY: 'bb_sk_...' }\`で公開します。

<span id="webhook-function-post-fnmeetings-webhook"></span>

### Webhook関数（POST /fn/meetings-webhook）

\`\`\`ts
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmacBase64(secret: string, body: string) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const rawBody = await req.text();
  const sig = req.headers.get('x-bb-signature') ?? '';
  const event = req.headers.get('x-bb-event') ?? '';

  // wsec_... from PUT, stored in envVars.MEETINGS_WEBHOOK_SECRET
  const expected = \`v1,\${await hmacBase64(ctx.env.MEETINGS_WEBHOOK_SECRET, rawBody)}\`;
  if (!timingSafeEqual(expected, sig)) return new Response('invalid signature', { status: 401 });

  const payload = JSON.parse(rawBody);
  const botId = payload?.data?.bot?.id;
  if (!botId) return new Response('ok');

  let nextStatus: string | null = null;
  if (event === 'bot.in_call_recording') nextStatus = 'recording';
  else if (event === 'bot.done') nextStatus = 'done';
  else if (event === 'bot.fatal') nextStatus = 'fatal';

  let recordingUrl: string | null = null;
  let transcriptUrl: string | null = null;
  if (event === 'recording.done' || event === 'transcript.done' || event === 'bot.done') {
    const res = await fetch(
      \`\${ctx.env.BUTTERBASE_API_URL}/v1/\${ctx.env.BUTTERBASE_APP_ID}/ai/meetings/\${botId}\`,
      { headers: { authorization: \`Bearer \${ctx.env.BUTTERBASE_API_KEY}\` } },
    );
    if (res.ok) {
      const bot = await res.json();
      recordingUrl = bot.recordingUrl ?? null;
      transcriptUrl = bot.transcriptUrl ?? null;
    }
  }

  await ctx.db.query(
    \`UPDATE meetings
        SET status = COALESCE($2, status),
            last_event = $3,
            recording_url = COALESCE($4, recording_url),
            transcript_url = COALESCE($5, transcript_url),
            events_count = events_count + 1
      WHERE bot_id = $1\`,
    [botId, nextStatus, event, recordingUrl, transcriptUrl],
  );
  return new Response(JSON.stringify({ ok: true }));
}
\`\`\`

HTTPトリガーでpath: /meetings-webhook、auth: noneを指定し、MEETINGS_WEBHOOK_SECRETとBUTTERBASE_API_KEYを環境変数に設定します。呼び出し元は関数内のHMACで検証するため、auth: noneが適切です。

<span id="drive-it"></span>

### 実行

\`\`\`bash
curl -X POST https://{app_id}.api.butterbase.ai/fn/spawn-bot \\
  -H "content-type: application/json" \\
  -d '{ "meetingUrl": "https://zoom.us/j/12345..." }'
# → { "bot_id": "...", "status": "joining" }
\`\`\`

ボットが参加し、状態が進むとmeetings-webhookへ通知します。行には最新状態と録画・文字起こしURLを保持します。

<span id="reference"></span>

## リファレンス

- [AI会議API](https://docs.butterbase.ai/ja/api-reference/ai-meetings-api/) — 全経路とリクエスト・レスポンス
- [TypeScript SDK](https://docs.butterbase.ai/ja/sdks-and-tools/typescript-sdk/) — bb.ai.meetings.start／get／list／stop／estimateCost
- [CLI](https://docs.butterbase.ai/ja/sdks-and-tools/cli/) — bb ai meetings start／get／list／stop／estimate／usage／webhook

---

会議ボットの起動、状態確認、録画・文字起こしの取得、Webhookの配信設定に使うAPIです。概要と一連の使用例は[AI会議](https://docs.butterbase.ai/ja/core-concepts/ai-meetings/)を参照してください。

すべてのエンドポイントはアプリ単位です。URLに\`app_id\`を指定し、そのアプリの所有者のButterbaseサービスキー（\`bb_sk_...\`）で認証します。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|---|---|---|
| POST | /v1/\\{app_id\\}/ai/meetings | 会議ボットを起動 |
| GET | /v1/\\{app_id\\}/ai/meetings/\\{bot_id\\} | ボットの状態、時間、URLを取得 |
| DELETE | /v1/\\{app_id\\}/ai/meetings/\\{bot_id\\} | ボットを会議から退出させる |
| GET | /v1/\\{app_id\\}/ai/meetings | アプリのボット一覧を取得 |
| GET | /v1/\\{app_id\\}/ai/meetings/\\_estimate | 会議の米ドル建て料金を見積もる |
| GET | /v1/\\{app_id\\}/ai/meetings/usage | アプリの最近の\`actor_usage_logs\`を取得 |
| PUT | /v1/\\{app_id\\}/ai/meetings/webhook | 転送先URLを設定し、署名用シークレットを発行・更新 |
| GET | /v1/ai/meetings/\\_status | 認証不要の公開API。\`{ "available": true \\| false }\` |

<span id="spawn-a-bot"></span>

## ボットの起動

\`\`\`
POST /v1/{app_id}/ai/meetings
Authorization: Bearer {token}
Content-Type: application/json

{
  "meetingUrl": "https://zoom.us/j/12345...",
  "transcript": true,
  "recording": "mp4",
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" },
  "automaticLeave": {
    "waitingRoomTimeoutSec": 900,
    "noOneJoinedTimeoutSec": 600,
    "everyoneLeftTimeoutSec": 120,
    "inCallNotRecordingTimeoutSec": 1800
  }
}
\`\`\`

| フィールド | 型 | 既定値 | 補足 |
|---|---|---|---|
| \`meetingUrl\` | string | 必須 | Zoom・Meet・Teams・Webexの会議URL |
| \`transcript\` | boolean | \`true\` | 録画に加えて文字起こしを実行 |
| \`recording\` | \`"mp4" \\| "audio_only" \\| false\` | \`"mp4"\` | \`false\`なら録画しません。 |
| \`botName\` | string | \`"Butterbase Notetaker"\` | 会議に参加するときの表示名。1〜64文字。 |
| \`metadata\` | \`Record<string,string>\` | \`{}\` | 任意の文字列のキーと値。予約済みの\`bb_\`で始まるキーは使えません。 |
| \`automaticLeave\` | object | \`{}\` | ボットごとの自動退出タイマー。省略したサブフィールドはプロバイダーの既定値を使います。[自動退出のタイマー](https://docs.butterbase.ai/ja/api-reference/ai-meetings-api/#auto-leave-timers)を参照してください。 |

<span id="auto-leave-timers"></span>

### 自動退出のタイマー

ボットが自動で退出するまでの待ち時間を指定します。各フィールドは任意で、省略するとプロバイダーの既定値を使います。値は**秒**単位の正の整数で、最大\`86400\`（24時間）です。

| サブフィールド | 退出する条件 |
|---|---|
| \`waitingRoomTimeoutSec\` | 主催者に入室を許可されず、待機室で指定秒数が経過したとき。 |
| \`noOneJoinedTimeoutSec\` | ボットだけが入室し、指定秒数以内に誰も参加しなかったとき。 |
| \`everyoneLeftTimeoutSec\` | 全員が退出し、空の会議室で指定秒数が経過したとき。 |
| \`inCallNotRecordingTimeoutSec\` | 会議に参加しているが録画できず、指定秒数が経過したとき（例：録画の同意が得られない場合）。 |

**例：15分以内に入室を許可されなければ退出する設定：**

\`\`\`json
{ "automaticLeave": { "waitingRoomTimeoutSec": 900 } }
\`\`\`

応答：

\`\`\`json
{
  "id": "c086e720-d319-44b8-82d8-3a363f2cd9f4",
  "status": "joining",
  "startedAt": null,
  "completedAt": null,
  "durationSeconds": null,
  "recordingUrl": null,
  "transcriptUrl": null,
  "botName": "Acme Notetaker",
  "metadata": { "session_id": "abc123" }
}
\`\`\`

\`botName\`は応答にも含まれ、送信した名前を確認できます。このフィールドの対応前に作成したボットでは\`"Butterbase Notetaker"\`を返します。

処理の進行に応じて\`startedAt\`、\`completedAt\`、各URLが設定されます。\`GET /v1/{app_id}/ai/meetings/{id}\`をポーリングするか、Webhookで確認してください。

<span id="get-a-bot"></span>

## ボットの取得

\`\`\`
GET /v1/{app_id}/ai/meetings/{bot_id}
Authorization: Bearer {token}
\`\`\`

\`POST\`と同じ形式を返します。\`status\`は次の状態を表します。

| 状態 | 意味 |
|---|---|
| \`joining\` | ボットが接続中 |
| \`waiting_room\` | 待機室で主催者の許可待ち |
| \`in_call\` | 会議に参加済み（録画開始前の場合もあります） |
| \`recording\` | 録画中 |
| \`ended\` | 会議が終了し、成果物を処理中 |
| \`done\` | 正常終了。\`recordingUrl\`と\`transcriptUrl\`を利用できます。 |
| \`fatal\` | 参加失敗、退出させられた、または致命的なエラーで終了 |

<span id="list-bots"></span>

## ボット一覧の取得

\`\`\`
GET /v1/{app_id}/ai/meetings?status={status}&limit={n}&cursor={cursor}
Authorization: Bearer {token}
\`\`\`

クエリパラメーター（すべて任意）：

| パラメーター | 型 | 既定値 | 補足 |
|---|---|---|---|
| \`status\` | string | — | 状態で絞り込む |
| \`limit\` | integer | 20 | 1〜100 |
| \`cursor\` | string | — | 前の応答の\`nextCursor\`を指定 |

応答：

\`\`\`json
{
  "bots": [ /* MeetingBot[] */ ],
  "nextCursor": "..." | null
}
\`\`\`

<span id="stop-a-bot"></span>

## ボットの停止

\`\`\`
DELETE /v1/{app_id}/ai/meetings/{bot_id}
Authorization: Bearer {token}
\`\`\`

ボットを会議から退出させます。成功時は\`204\`です。停止済み・終了済みでも\`204\`を返す冪等な操作です。

<span id="cost-estimate"></span>

## 料金の見積もり

\`\`\`
GET /v1/{app_id}/ai/meetings/_estimate?durationMinutes={n}&transcript={bool}
Authorization: Bearer {token}
\`\`\`

| パラメーター | 型 | 既定値 | 補足 |
|---|---|---|---|
| \`durationMinutes\` | integer | 必須 | 1〜1440 |
| \`transcript\` | boolean | \`true\` | 文字起こしの料金を含めるかどうか |

応答：

\`\`\`json
{ "usd": 0.39 }
\`\`\`

<span id="configure-forward-webhook"></span>

## 転送Webhookの設定

\`\`\`
PUT /v1/{app_id}/ai/meetings/webhook
Authorization: Bearer {token}
Content-Type: application/json

{
  "forward_url": "https://your-app.example.com/recall/events",
  "rotate_secret": true
}
\`\`\`

| フィールド | 型 | 補足 |
|---|---|---|
| \`forward_url\` | string (URL) | Butterbaseが転送イベントをPOSTするURL |
| \`rotate_secret\` | boolean | trueの場合、または設定がまだない場合に、アプリ専用の新しいシークレットを発行 |

応答：

\`\`\`json
{
  "ok": true,
  "app_id": "app_abc123",
  "forward_url": "https://your-app.example.com/recall/events",
  "secret": "wsec_..."
}
\`\`\`

\`secret\`を返すのは、初回作成時または\`rotate_secret: true\`による更新時の**1回だけ**です。すぐに保存してください。それ以外は\`null\`を返します。ButterbaseではAES-256-GCMで暗号化して保存し、転送イベントへ署名する間だけ復号します。

<span id="forwarded-event-shape"></span>

### 転送イベントの形式

ボットの状態が変化したとき、または成果物の準備ができたときに、Butterbaseから\`forward_url\`へPOSTします。

\`\`\`
POST /your/configured/path
content-type: application/json
x-bb-event: bot.done
x-bb-signature: v1,<base64 HMAC-SHA256>

{
  "event": "bot.done",
  "data": {
    "bot":  { "id": "c086e720-...", "metadata": { ... } },
    "data": { "code": "done", "sub_code": null, "updated_at": "..." }
  }
}
\`\`\`

<span id="verifying-the-signature"></span>

### 署名の検証

\`base64(HMAC-SHA256(<your wsec_>, <raw request body>))\`を計算し、先頭に\`v1,\`を付けて\`x-bb-signature\`と定数時間で比較します。Stripe・GitHub・Recall.aiと同様の検証方式です。[実装例](https://docs.butterbase.ai/ja/core-concepts/ai-meetings/#verifying-a-forwarded-event)を参照してください。

<span id="default-subscriptions"></span>

### 既定の購読イベント

新しいアプリには、既定で次のイベントを転送します。

- \`bot.in_call_recording\`
- \`bot.done\`
- \`bot.fatal\`
- \`recording.done\`
- \`transcript.done\`
- \`transcript.failed\`

<span id="webhook-payloads-carry-ids-not-urls"></span>

### Webhookで受け取る成果物のID

\`recording.done\`と\`transcript.done\`には、成果物の**ID**とメタデータだけが含まれます。ダウンロードURLは\`GET /v1/{app_id}/ai/meetings/{bot_id}\`の応答の\`recordingUrl\`と\`transcriptUrl\`から取得してください。URLは短期間で失効し、Recallが必要に応じて再発行するため、Webhook本文には含めません。

<span id="usage"></span>

## 使用量

\`\`\`
GET /v1/{app_id}/ai/meetings/usage
Authorization: Bearer {token}
\`\`\`

\`actor_usage_logs\`の最新100件を返します。

\`\`\`json
{
  "rows": [
    {
      "id": "5",
      "dimension": "recording",
      "seconds": 44,
      "usd_charged": "0.007333",
      "created_at": "2026-06-11T19:18:53.734Z"
    },
    {
      "id": "4",
      "dimension": "transcription",
      "seconds": 44,
      "usd_charged": "0.002200",
      "created_at": "2026-06-11T19:18:53.485Z"
    }
  ]
}
\`\`\`

終了した会議ごとに、\`recording\`と、文字起こしが有効なら\`transcription\`の各項目につき1行を記録します。

<span id="availability"></span>

## 利用可否

\`\`\`
GET /v1/ai/meetings/_status
\`\`\`

認証なしで利用できる公開エンドポイントです。次の形式を返します。

\`\`\`json
{ "available": true }
\`\`\`

\`false\`の場合、この環境にはプロバイダーが登録されていません（例：\`MEETINGS_API_KEY\`を設定していないOSS版）。クライアント側で対応する画面や操作の表示を切り替えられます。

<span id="errors"></span>

## エラー

OpenAI互換の形式：\`{ "error": { "message", "type", "code" } }\`。

| 状態 | \`error.type\` | \`error.code\` | 発生条件 |
|---|---|---|---|
| 400 | \`invalid_request_error\` | \`invalid_request\` | リクエスト本文の検証に失敗。\`error.details\`にzodの検証結果を返します。 |
| 401 | \`authentication_error\` | \`missing_credentials\` | Authorizationヘッダーがないか無効です。 |
| 402 | \`billing_error\` | \`insufficient_credits\` | 残高が組織の利用可能下限を下回っているため、新しい会議を開始できません。\`error.balance_usd\`（月間利用枠と追加購入分の合計残高）と\`error.credit_floor_usd\`（利用可能な最低残高。与信がなければ\`0\`）を返します。 |
| 403 | \`permission_error\` | \`not_authorized\` | 認証済みのユーザーがこのアプリの所有者ではありません。 |
| 404 | \`invalid_request_error\` | \`app_not_found\` | \`app_id\`が存在しません。 |
| 501 | \`api_error\` | \`provider_unavailable\` | この環境に会議プロバイダーが登録されていません。 |
| 5xx | \`api_error\` | (varies) | 接続先のプロバイダーのエラー。間隔を空けて再試行してください。 |`,
  billing: `このページでは、**アプリのエンドユーザーから自分のStripeアカウントへ代金を受け取る方法**を説明します。

Butterbaseから**自分への請求**（プランの利用枠、AIクレジット、支出上限、使用量）は[プランと使用量](https://docs.butterbase.ai/ja/core-concepts/plans-and-usage/)を参照してください。

標準の**Stripe Connect**連携で、定期プランと買い切り商品を販売できます。Stripe用のコード、決済画面、Webhookサーバーを用意する必要はありません。

<span id="what-you-get"></span>

## 利用できる機能

- **自分のStripeアカウントへ入金。** 自分が所有するStripe Expressアカウントを作成し、そのアカウントで決済します。Stripeから銀行へ入金されます。
- **プラットフォーム手数料0%。** \`platform_fee_cents\`は常に0で、Butterbaseの取り分はありません。Stripeの通常の決済手数料は必要です。
- **Stripeの決済画面。** 購入ごとにStripe Checkout URLを返し、カード情報はStripeが処理します。
- **Webhookを処理。** 開始、更新、失敗、解約、返金の結果をアプリのテーブルへ記録します。
- **データベースの購読・注文モデル。** \`app_plans\`、\`app_products\`、\`app_subscriptions\`、\`app_orders\`を関数やRLSから参照できます。
- **複数の操作方法。** ダッシュボード、REST、CLI（\`butterbase app-billing\`）、SDK（\`bb.billing.*\`）、MCP。

<span id="before-you-begin"></span>

## 事前準備

- [ ] アプリを作成し、**ユーザーがButterbase Authでログイン**できる状態にします。メールのある\`app_users\`の行が必要です。[認証](https://docs.butterbase.ai/ja/core-concepts/authentication/)を参照してください。
- [ ] Stripeアカウントを用意し、国ごとの本人・銀行確認を完了できることを確認します。
- [ ] 定期**プラン**、買い切り**商品**、または両方を選びます。
- [ ] フロントエンドに\`successUrl\`と\`cancelUrl\`を用意します。

<span id="step-1--onboard-your-stripe-connect-account"></span>

## 手順1：Stripe Connectへの登録

アプリ用のStripe Expressアカウントを作成し、Stripeの登録用リンクを取得します。

**ダッシュボード（推奨）：** **App → Monetization → Stripe Connect → Connect with Stripe**を選び、Stripeで登録して戻ります。

**REST API：**

\`\`\`
POST /v1/{app_id}/billing/connect/onboard
Authorization: Bearer {platform_api_key}
\`\`\`

\`\`\`json
{
  "accountId": "acct_1Nv...",
  "onboardingUrl": "https://connect.stripe.com/setup/e/acct_1Nv.../..."
}
\`\`\`

**SDK：**

\`\`\`typescript
const { data } = await bb.billing.connectOnboard();
window.location.href = data.onboardingUrl;
\`\`\`

:::caution
Connect、プラン、商品の管理は**アプリの所有者だけ**が呼び出せます。他の組織メンバーには\`403 Not authorized\`を返します。
:::

\`onboardingUrl\`を開き、事業情報、本人確認、入金先の銀行を登録します。リンクは1回限りで有効期限があるため、必要なら再発行してください。審査に数分以上かかることがあり、国によっては書類審査が終わるまで\`payouts_enabled\`が有効になりません。

<span id="step-2--confirm-you-can-accept-payments"></span>

## 手順2：決済できる状態の確認

\`\`\`
GET /v1/{app_id}/billing/connect/status
\`\`\`

\`\`\`json
{
  "accountId": "acct_1Nv...",
  "chargesEnabled": true,
  "detailsSubmitted": true,
  "payoutsEnabled": true
}
\`\`\`

| フィールド | trueになると可能なこと |
|-------|------------------------|
| \`detailsSubmitted\` | Stripeの登録完了 |
| \`chargesEnabled\` | **決済画面の作成**。無効なら\`CONNECT_NOT_READY\`で拒否。 |
| \`payoutsEnabled\` | Stripeから銀行への入金 |

\`chargesEnabled\`がfalseなら、手順1へ戻ってStripeが要求する登録を完了してください。

<span id="step-3--choose-your-pricing-model"></span>

## 手順3：料金モデルの選択

| 販売するもの | 使用するモデル | 作成するオブジェクト |
|---|---|---|
| 月額・年額の利用権 | **プラン** | \`app_plans\` → \`app_subscriptions\` |
| 買い切り（デジタル商品、クレジット、無期限の利用権） | **商品** | \`app_products\` → \`app_orders\` |
| 両方 | 両方 | — |

プランと商品は独立しており、それぞれ複数作成できます。

<span id="step-4a--create-subscription-plans"></span>

## 手順4a：定期プランの作成

\`\`\`json
POST /v1/{app_id}/billing/plans
Authorization: Bearer {platform_api_key}

{
  "name": "Pro",
  "priceCents": 999,
  "interval": "month",
  "features": ["Unlimited projects", "Priority support", "Custom domain"]
}
\`\`\`

| フィールド | 型 | 補足 |
|-------|------|-------|
| \`name\` | string, 1–100 chars | Stripe Checkoutの商品名として表示 |
| \`priceCents\` | integer ≥ 0 | **セント単位**。999は9.99米ドル。定期プランは米ドル建てです。 |
| \`interval\` | \`"month"\` \\| \`"year"\` | 既定値は\`"month"\`。 |
| \`features\` | string[] | 画面で使う任意の特徴の箇条書き |

作成した行を返します。\`id\`（UUID）を\`subscribe\`へ指定します。

\`\`\`bash
butterbase app-billing plans create --name "Pro" --price-cents 999 --interval month
butterbase app-billing plans list
\`\`\`

\`\`\`typescript
const { data: plan } = await bb.billing.createPlan({
  name: 'Pro', priceCents: 999, interval: 'month',
  features: ['Unlimited projects', 'Priority support'],
});
\`\`\`

**プランの変更：**

\`\`\`json
PUT /v1/{app_id}/billing/plans/{plan_id}
{ "priceCents": 1299, "active": true }
\`\`\`

\`name\`、\`priceCents\`、\`features\`、\`active\`を更新できます。\`interval\`は変更できないため、新しいプランを作成してください。\`active: false\`で新規受付を停止しても、既存の購読は続きます。

:::note
料金変更は**新しい決済だけ**に適用します。既存の購読者は再契約するまで元の料金です。
:::

<span id="step-4b--create-one-time-products"></span>

## 手順4b：買い切り商品の作成

\`\`\`json
POST /v1/{app_id}/billing/products
Authorization: Bearer {platform_api_key}

{
  "name": "Premium Template Pack",
  "description": "50+ premium UI templates",
  "priceCents": 2999,
  "metadata": { "category": "templates", "sku": "TPL-50" }
}
\`\`\`

| フィールド | 型 | 補足 |
|-------|------|-------|
| \`name\` | string, 1–100 chars | 決済画面の商品名 |
| \`description\` | string, ≤ 500 chars | 任意。決済画面に表示。 |
| \`priceCents\` | integer ≥ 0 | セント単位 |
| \`metadata\` | \`Record<string,string>\` | 注文にも含める独自のキー。商品提供の判断に使えます。 |

通貨の既定値は\`usd\`です。\`PUT /v1/{app_id}/billing/products/{product_id}\`で\`name\`、\`description\`、\`priceCents\`、\`active\`、\`metadata\`を更新できます。

\`\`\`bash
butterbase app-billing products create --name "Template Pack" --price-cents 2999
\`\`\`

<span id="step-5--show-the-catalog-in-your-app"></span>

## 手順5：アプリに一覧を表示

プランと商品の一覧は**公開**APIです。認証なしで、ログイン前の料金ページにも表示できます。

\`\`\`
GET /v1/{app_id}/billing/plans      → { "plans":   [...] }
GET /v1/{app_id}/billing/products   → { "products": [...] }
\`\`\`

\`\`\`typescript
const { data: plans } = await bb.billing.listPlans();
const { data: products } = await bb.billing.listProducts();
\`\`\`

\`active\`がfalseの行は表示から除外してください。過去の購読で名前を参照できるよう、無効な行もAPIは返します。

<span id="step-6--send-a-user-to-checkout"></span>

## 手順6：決済画面へ移動

:::danger
\`subscribe\`と\`purchase\`は**エンドユーザーとして**呼び出します。Butterbase AuthのアプリJWTを使い、プラットフォームAPIキーは使いません。JWTのユーザーIDへ購読を紐付けます。
:::

**定期プランの購入：**

\`\`\`json
POST /v1/{app_id}/billing/subscribe
Authorization: Bearer {end_user_app_jwt}

{
  "planId": "3f9a…-uuid",
  "successUrl": "https://yourapp.com/billing/success",
  "cancelUrl":  "https://yourapp.com/pricing"
}
\`\`\`

\`\`\`json
{ "sessionId": "cs_live_…", "url": "https://checkout.stripe.com/c/pay/cs_live_…" }
\`\`\`

**買い切り商品の購入：**

\`\`\`json
POST /v1/{app_id}/billing/purchase
Authorization: Bearer {end_user_app_jwt}

{ "productId": "8b21…-uuid", "successUrl": "…", "cancelUrl": "…" }
\`\`\`

\`\`\`json
{ "sessionId": "cs_live_…", "url": "https://checkout.stripe.com/…", "orderId": "0c7d…-uuid" }
\`\`\`

決済画面を開く**前に**\`app_orders\`へ\`pending\`の行を保存するため、対応するIDを追跡できます。

次に決済画面へ移動します。

\`\`\`typescript
const { data, error } = await bb.billing.subscribe({
  planId: plan.id,
  successUrl: \`\${window.location.origin}/billing/success\`,
  cancelUrl: \`\${window.location.origin}/pricing\`,
});
if (error) return showError(error);
window.location.href = data.url;
\`\`\`

\`successUrl\`と\`cancelUrl\`は任意ですが、指定してください。既定値は自分のアプリではなくButterbaseのダッシュボードです。

<span id="step-7--understand-what-happens-after-payment"></span>

## 手順7：決済後の処理

ユーザーが\`successUrl\`へ戻っただけでは確定しません。Stripeの確認後、ConnectのWebhookが結果をテーブルへ記録します。

| Stripeイベント | Butterbaseの処理 |
|-------|----------------------|
| \`checkout.session.completed\` | 購読を有効化、または注文を\`paid\`に変更 |
| \`invoice.paid\` | 購読期間を更新 |
| \`invoice.payment_failed\` | 購読を\`past_due\`に変更 |
| \`customer.subscription.updated\` | 状態と\`cancel_at_period_end\`を同期 |
| \`customer.subscription.deleted\` | 購読を解約済みに変更 |
| \`payment_intent.payment_failed\` | 注文を\`failed\`に変更 |
| \`charge.refunded\` | 注文を\`refunded\`に変更し、\`refunded_at\`を記録 |

StripeのイベントIDで重複を防ぐため、再試行でも二重処理しません。

**Butterbase Cloudでは設定は不要です。** Expressアカウントのイベントを自動で受信します。\`GET /billing/subscription\`や\`GET /billing/orders\`の状態を読み取ってください。Webhookが後から届くこともあるため、\`successUrl\`への移動だけで利用権を付与しないでください。

:::note[セルフホストの場合]
自分のControl APIでは、\`https://<your-control-api>/webhooks/stripe/connect\`をStripeへ登録し、**Listen to events on Connected accounts**を有効にします。\`account\`のないイベントは処理しません。上記イベントを購読し、署名用シークレットを\`STRIPE_CONNECT_WEBHOOK_SECRET\`に設定してください。
:::

<span id="step-8--gate-access-on-subscription-status"></span>

## 手順8：購読状態によるアクセス制御

\`\`\`
GET /v1/{app_id}/billing/subscription
Authorization: Bearer {end_user_app_jwt}
\`\`\`

\`\`\`json
{
  "subscription": {
    "id": "…", "plan_id": "…", "status": "active",
    "current_period_start": "2026-08-01T00:00:00Z",
    "current_period_end":   "2026-09-01T00:00:00Z",
    "cancel_at_period_end": false,
    "plan_name": "Pro", "price_cents": 999, "interval": "month",
    "features": ["Unlimited projects"]
  }
}
\`\`\`

購読がなければ\`{ "subscription": null }\`です。\`active\`、\`trialing\`、\`past_due\`だけを返し、解約済み・期限切れは\`null\`になります。

\`\`\`typescript
const { data: sub } = await bb.billing.getSubscription();
const isPro = sub !== null && sub.status === 'active';
\`\`\`

**UIだけでなくサーバー側で制御してください。** [サーバーレス関数](https://docs.butterbase.ai/ja/core-concepts/functions/)で呼び出し元の\`app_subscriptions\`を確認してから、有料の処理を行います。

\`\`\`sql
SELECT 1 FROM app_subscriptions
WHERE app_id = $1 AND user_id = $2
  AND status IN ('active', 'trialing')
  AND current_period_end > now();
\`\`\`

同じテーブルを[行レベルセキュリティ](https://docs.butterbase.ai/ja/core-concepts/row-level-security/)で参照し、有効な購読のあるユーザーだけに行を公開できます。

<span id="step-9--cancellation"></span>

## 手順9：解約

\`\`\`
POST /v1/{app_id}/billing/cancel
Authorization: Bearer {end_user_app_jwt}
\`\`\`

\`cancel_at_period_end = true\`を設定します。\`current_period_end\`まで利用でき、その後Stripeの\`customer.subscription.deleted\`で購読が取得されなくなります。有効な購読がなければ404です。

再開用のエンドポイントはありません。再度購入してください。

<span id="step-10--fulfilling-one-time-purchases"></span>

## 手順10：買い切り商品の提供

\`\`\`
GET /v1/{app_id}/billing/orders            → { "orders": [...] }
GET /v1/{app_id}/billing/orders/{order_id} → one order
\`\`\`

いずれもエンドユーザー単位で、自分の注文だけを取得できます。

| 状態 | 意味 |
|--------|---------|
| \`pending\` | 決済画面を作成済み、支払いは未完了 |
| \`paid\` | 決済成功。**この状態で商品を提供**。 |
| \`failed\` | 決済失敗 |
| \`refunded\` | 返金済み。\`refunded_at\`を設定。 |

\`pending\`では提供しないでください。完了画面で\`paid\`を確認するか、関数内で注文を確認してから提供します。注文の商品の\`metadata\`で提供内容を判断できます。

<span id="testing-before-you-launch"></span>

## 公開前のテスト

1. Stripeを**テストモード**にし、テスト用の事業情報でConnectの登録を完了します。
2. テスト用のプランと商品を作ります。
3. エンドユーザーとしてログインし、\`subscribe\`と\`purchase\`を呼び出します。
4. テストカード\`4242 4242 4242 4242\`、未来の有効期限、任意のCVCで決済します。失敗例には\`4000 0000 0000 0341\`を使います。
5. Webhookを確認し、購読が\`active\`、または注文が\`paid\`になったことを確認します。
6. 解約と返金も試し、Stripeでの返金後に注文が\`refunded\`になることを確認します。

<span id="going-live-checklist"></span>

## 本番開始の確認

- [ ] \`connect/status\`の\`chargesEnabled\`と\`payoutsEnabled\`が両方有効
- [ ] 販売しないプランと商品は\`active: false\`
- [ ] \`successUrl\`と\`cancelUrl\`が自分のドメイン
- [ ] サーバー側でアクセスを制御
- [ ] Connectアカウントに必要な利用規約と返金方針を用意

<span id="troubleshooting"></span>

## 問題の解決

| エラーコード | HTTP | 原因 | 対処 |
|---|---|---|---|
| \`CONNECT_NOT_CONFIGURED\` | 400 | Stripeアカウントが未接続 | 手順1を実行 |
| \`CONNECT_NOT_READY\` | 400 | Stripeの\`charges_enabled\`がfalse | 登録を完了し、手順2を再確認 |
| \`PLAN_NOT_FOUND\` | 404 | planIdが不正、別アプリ、または\`active: false\` | 一覧とUUIDを確認 |
| \`PRODUCT_NOT_FOUND\` | 404 | 商品に対する同様の問題 | 商品一覧を確認 |
| \`USER_NOT_FOUND\` | 404 | トークンのユーザーIDの\`app_users\`行がない | このアプリのButterbase Authユーザーとして呼び出す |
| \`403 Not authorized\` | 403 | 所有者以外が開発者用APIを呼び出した | 所有者の認証情報を使う |
| \`subscribe\`・\`purchase\`・\`orders\`の\`401\` | 401 | エンドユーザーのアプリJWTとして利用できないトークン | 手順6を確認 |
| 決済後に有効にならない | — | 確定前のリダイレクトだけで判断したか、Webhookが未設定 | 購読・注文を再取得。セルフホストでは手順7とStripeの配信ログを確認。 |

<span id="endpoint-reference"></span>

## エンドポイントの一覧

**開発者用：プラットフォーム認証、所有者専用：**

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | \`/v1/{app_id}/billing/connect/onboard\` | Stripe Connectの登録リンクを作成・更新 |
| GET | \`/v1/{app_id}/billing/connect/status\` | 登録、決済、入金の状態 |
| POST | \`/v1/{app_id}/billing/plans\` | 定期プランを作成 |
| PUT | \`/v1/{app_id}/billing/plans/{plan_id}\` | プランを更新 |
| POST | \`/v1/{app_id}/billing/products\` | 商品を作成 |
| PUT | \`/v1/{app_id}/billing/products/{product_id}\` | 商品を更新 |

**公開：**

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | \`/v1/{app_id}/billing/plans\` | プラン一覧 |
| GET | \`/v1/{app_id}/billing/products\` | 商品一覧 |

**エンドユーザー用：アプリJWT：**

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | \`/v1/{app_id}/billing/subscribe\` | 定期プランの決済を開始 |
| GET | \`/v1/{app_id}/billing/subscription\` | 現在の購読 |
| POST | \`/v1/{app_id}/billing/cancel\` | 期間終了時に解約 |
| POST | \`/v1/{app_id}/billing/purchase\` | 商品を購入 |
| GET | \`/v1/{app_id}/billing/orders\` | 注文履歴 |
| GET | \`/v1/{app_id}/billing/orders/{order_id}\` | 注文を1件取得 |

<span id="data-model"></span>

## データモデル

| テーブル | 保存内容 |
|-------|-------|
| \`app_plans\` | 定期プラン（\`name\`、\`price_cents\`、\`interval\`、\`features\`、\`active\`） |
| \`app_products\` | 買い切り商品（\`name\`、\`description\`、\`price_cents\`、\`currency\`、\`metadata\`、\`active\`） |
| \`app_subscriptions\` | ユーザーの購読ごとの行（\`status\`、期間、\`cancel_at_period_end\`） |
| \`app_orders\` | 購入の試行ごとの行（\`amount_cents\`、\`platform_fee_cents\`、\`status\`、\`refunded_at\`） |

アプリのランタイムデータベースにあり、関数とRLSから直接参照できます。

<span id="not-using-connect"></span>

## Connectを使わない場合

[サーバーレス関数](https://docs.butterbase.ai/ja/core-concepts/functions/)からStripeなどを直接呼び出し、自分のテーブルに状態を保存することもできます。この場合、Webhook、購読モデル、PCI対応、キー管理は自分で実装・管理します。[収益化ガイド](https://docs.butterbase.ai/ja/guides/monetization/)にConnectの一連の手順があります。

---

このページは、バックエンドの運用に対して**Butterbaseへ支払う料金**の説明です。

**自分のエンドユーザーへの課金**は[ユーザーへの課金](https://docs.butterbase.ai/ja/core-concepts/billing/)を参照してください。

<span id="plans"></span>

## プラン

4つのプランがあり、上位ほど下位の機能に追加機能が加わります。

| | |
|---|---|
| **Playground** | 無料。動作を試すためのプランで、カード登録は不要。 |
| **Launch** | Playgroundの全機能と、実ユーザー向け公開に必要な容量、[カスタムドメイン](https://docs.butterbase.ai/ja/core-concepts/custom-domains/)、[プレビューデプロイ](https://docs.butterbase.ai/ja/core-concepts/preview-deployments/)。 |
| **Certified** | Launchの全機能、成長に必要な容量、より多くのAI利用枠、優先サポート。 |
| **Enterprise** | Certifiedの全機能、SSO、SOC 2報告書、HIPAA追加機能、稼働時間保証、専任窓口。価格は相談。 |

課金単位はアプリではなく**組織**です。全アカウントはPlaygroundから始まります。

価格と利用枠は変更されるため、このページには転記しません。最新値は次で確認できます。

- **[butterbase.ai/pricing](https://butterbase.ai/pricing)** — プランの比較
- **[ダッシュボードのBilling](https://dashboard.butterbase.ai/billing)** — 自分の組織のプランと、各上限に対する現在の使用量

\`\`\`bash
butterbase billing status
\`\`\`

Playgroundのプロジェクトは活動が1週間ないと一時停止します。データは削除せず、戻ったときにダッシュボードから再開できます。

<span id="usage-meters"></span>

## 使用量の計測

| メーター | 計測対象 |
|-------|-----------------|
| \`ai_credits\` | AIモデルの利用費用（ドル） |
| \`storage_bytes\` | 組織内の全アプリの合計ファイル容量 |
| \`lambda_invocations\` | 関数の合計実行数 |
| \`bandwidth_bytes\` | 送信したデータ量 |

<span id="credits-top-ups-and-spending-caps"></span>

## クレジット・追加購入・支出上限

組織ごとのAIクレジットを、次の順序で消費します。

1. **月次利用枠** — プランごとのクレジット。サブスクリプション請求の支払い成功時に補充。
2. **追加購入残高** — 事前購入する従量制クレジット。有効期限なし。

両方がなくなるとAI呼び出しを停止します。追加購入かアップグレードで再開でき、裏で料金が増え続けることはありません。

**クレジットの追加購入：**

\`\`\`
POST /dashboard/billing/topup
{ "amount": 25 }
\`\`\`

\`\`\`bash
butterbase billing topup 25
\`\`\`

**支出上限**は組織ごとのAI支出の最大額です。ダッシュボードのBillingで確認・変更できます。

\`\`\`bash
butterbase billing cap get
butterbase billing cap raise --raise-by 50
\`\`\`

**自動補充**を設定すると、残高が指定値を下回ったときに追加購入します。Billingで設定できます。

<span id="checking-your-usage"></span>

## 使用量の確認

\`\`\`
GET /dashboard/billing
\`\`\`

現在のプラン、制限、使用率、クレジット残高、支出上限を返します。

\`\`\`
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_credits
\`\`\`

指定期間の日次使用量を返します。

\`\`\`bash
butterbase billing status
butterbase billing usage --start 2026-01-01 --end 2026-01-31 --meter ai_credits
\`\`\`

<span id="upgrading-your-plan"></span>

## プランのアップグレード

\`\`\`json
POST /dashboard/billing/checkout
{ "planId": "<plan-id>" }
\`\`\`

Stripe Checkoutの\`url\`を返します。支払い成功後、制限はすぐに更新されます。

<span id="managing-your-subscription"></span>

## サブスクリプションの管理

\`\`\`
POST /dashboard/billing/portal
\`\`\`

StripeのセルフサービスポータルURLを返します。支払方法の更新、請求書の取得、解約ができます。

\`\`\`bash
butterbase billing portal
\`\`\`

<span id="what-happens-when-you-exceed-a-limit"></span>

## 上限に達したとき

**無料プラン：** 組織をsoft-lockします。読み取りは可能で、使用量の減少かアップグレードまで書き込みを止めます。

**有料プラン：** AI残高がなくなると、追加購入かアップグレードまでAI呼び出しを止めます。ストレージなどの制限はプラン上限で判定します。支払い失敗では猶予期間を設け、期限を過ぎると組織を停止します。

<span id="account-statuses"></span>

## アカウントの状態

| ステータス | 意味 |
|--------|---------|
| \`active\` | 通常運用 |
| \`soft_locked\` | 無料プランの上限超過 |
| \`suspended\` | 支払い失敗後の猶予期間が終了 |

---

---

<span id="platform-billing"></span>

## プラットフォームの課金

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /dashboard/billing | 現在のプラン、使用量、上限 |
| GET | /dashboard/usage | 日ごとの使用履歴 |
| POST | /dashboard/billing/checkout | アップグレードの決済を開始 |
| POST | /dashboard/billing/portal | 課金ポータルを開く |

<span id="usage-history"></span>

### 使用履歴

\`\`\`
GET /dashboard/usage?startDate=2026-01-01&endDate=2026-01-31&meterType=ai_tokens
\`\`\`

| パラメーター | 説明 |
|-----------|-------------|
| \`startDate\` | 範囲の開始日（ISO日付） |
| \`endDate\` | 範囲の終了日（ISO日付） |
| \`meterType\` | フィルター：\`storage_bytes\`、\`ai_tokens\`、\`lambda_invocations\`、\`bandwidth_bytes\` |

<span id="stripe-connect-monetization"></span>

## Stripe Connect（収益化）

<span id="developer-endpoints-platform-auth"></span>

### 開発者向けエンドポイント（プラットフォーム認証）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/billing/connect/onboard | Connectの登録を開始 |
| GET | /v1/\\{app_id}/billing/connect/status | 登録状態を確認 |

<span id="subscription-plans"></span>

### サブスクリプションプラン

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/billing/plans | プランを作成 |
| GET | /v1/\\{app_id}/billing/plans | プランを一覧取得 |
| PUT | /v1/\\{app_id}/billing/plans/\\{plan_id} | プランを更新 |

**作成：**

\`\`\`json
{
  "name": "Pro Plan",
  "priceCents": 999,
  "interval": "month",
  "features": ["Feature 1", "Feature 2"]
}
\`\`\`

<span id="products-one-time-purchases"></span>

### 商品（単発購入）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/billing/products | 商品を作成 |
| GET | /v1/\\{app_id}/billing/products | 商品を一覧取得 |
| PUT | /v1/\\{app_id}/billing/products/\\{product_id} | 商品を更新 |

**作成：**

\`\`\`json
{
  "name": "Premium Template",
  "priceCents": 2999,
  "description": "50+ templates",
  "metadata": { "category": "templates" }
}
\`\`\`

<span id="end-user-endpoints-app-jwt"></span>

### エンドユーザー向けエンドポイント（アプリJWT）

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/billing/subscribe | サブスクリプションを開始 |
| GET | /v1/\\{app_id}/billing/subscription | 現在のサブスクリプション |
| POST | /v1/\\{app_id}/billing/cancel | 期間終了時の解約を設定 |
| POST | /v1/\\{app_id}/billing/purchase | 商品を購入 |
| GET | /v1/\\{app_id}/billing/orders | 注文を一覧取得 |
| GET | /v1/\\{app_id}/billing/orders/{order_id} | 注文の詳細を取得 |

<span id="webhooks"></span>

### Webhook

\`\`\`
POST /webhooks/stripe/connect
\`\`\`

Control APIの環境変数に\`STRIPE_CONNECT_WEBHOOK_SECRET\`を設定します。

処理するイベント：\`checkout.session.completed\`、\`customer.subscription.updated\`、\`customer.subscription.deleted\`、\`invoice.payment_succeeded\`、\`invoice.payment_failed\`、\`payment_intent.payment_failed\`、\`charge.refunded\``,
  platform: `<span id="mcp-over-http"></span>

## HTTP経由のMCP

MCPのツールはHTTP経由でも利用できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET, POST, DELETE | /mcp | Streamable HTTPによるMCPセッション |

\`Authorization: Bearer {platform_api_key}\`を指定すると、自分のアカウントとして実行します。アシスタントや自動処理がstdio MCPを使えず、HTTPSを呼び出せる場合に利用してください。

<span id="apps--regions"></span>

## アプリとリージョン

概要は[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)を参照してください。

<span id="list-supported-regions"></span>

### 対応リージョンの一覧

\`\`\`http
GET /v1/regions
\`\`\`

公開APIです。APIキーは不要です。

\`\`\`json
{ "regions": ["us-east-1", "us-west-2"] }
\`\`\`

<span id="create-an-app"></span>

### アプリの作成

\`\`\`http
POST /init
Authorization: Bearer {api_key}

{
  "name": "my-app",
  "region": "us-west-2"
}
\`\`\`

| フィールド | 必須 | 補足 |
|-------|----------|-------|
| \`name\` | はい | アプリの表示名。サブドメインの生成にも使用します。 |
| \`region\` | いいえ | \`GET /v1/regions\`で取得したリージョン。省略するとプラットフォームの既定値を使います。 |

\`{ app_id, api_base_url, region, ... }\`を返します。

<span id="move-an-app-to-another-region"></span>

### 別のリージョンへの移動

\`\`\`http
POST /v1/apps/{app_id}/move
Authorization: Bearer {api_key}

{ "dest_region": "us-east-1" }
\`\`\`

\`{ migration_id, status: "queued" }\`を返します。移動中も読み取りはできます。切り替え時に書き込みを一時停止し、移動が完了すると自動で再開します。

<span id="check-move-status"></span>

### 移動状況の確認

\`\`\`http
GET /v1/apps/{app_id}/migrations/{migration_id}
Authorization: Bearer {api_key}
\`\`\`

現在の工程、移動元と移動先のリージョン、所要時間を返します。

<span id="agent-guidance"></span>

## エージェント向け情報

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /llms.txt | LLMエージェント向けのプレーンテキストの説明 |

クイックスタート、よく使うパターン、エラーの形式、応答のメタデータを提供します。

<span id="app-access-mode"></span>

## アプリのアクセスモード

匿名リクエストがデータAPIとリアルタイムWebSocketを使えるかを制御します。概要は[アクセスモード](https://docs.butterbase.ai/ja/core-concepts/authentication/#access-modes)を参照してください。

| メソッド | パス | 用途 |
|--------|------|---------|
| PATCH | /v1/\\{app_id}/config/access-mode | \`public\`と\`authenticated\`を切り替える |
| POST | /v1/\\{app_id}/secure | \`access_mode = "authenticated"\`とユーザーごとのRLSポリシーを一括で設定 |

<span id="toggle-access-mode"></span>

### アクセスモードの変更

\`\`\`json
PATCH /v1/{app_id}/config/access-mode
Authorization: Bearer {token}

{ "access_mode": "authenticated" }
\`\`\`

<span id="secure-composite"></span>

### secureによる一括設定

\`\`\`json
POST /v1/{app_id}/secure
Authorization: Bearer {token}

{
  "tables": [
    { "table_name": "posts", "user_column": "author_id" },
    { "table_name": "comments", "user_column": "user_id", "public_read_column": "is_published" }
  ]
}
\`\`\`

本文が空、または\`tables\`を省略した場合は、アクセスモードだけを変更します。応答には\`tables_secured\`と\`table_errors\`が含まれます。一部のテーブルが失敗しても、呼び出し全体はロールバックしません。

<span id="app-visibility"></span>

## アプリの公開範囲

他のButterbaseユーザーがアプリをテンプレートとして見つけ、複製できるかを制御します。匿名リクエストによるデータAPIの利用を制御する[アクセスモード](https://docs.butterbase.ai/ja/api-reference/platform-api/#app-access-mode)とは別の設定です。\`visibility="public"\`と\`access_mode="authenticated"\`を同時に設定すると、テンプレートを共有しながら匿名のデータ読み取りを制限できます。

\`visibility\`の既定値は\`"private"\`です。\`"public"\`にするとダッシュボードのテンプレート一覧と\`GET /v1/templates\`に表示されます。\`listed: false\`を組み合わせると、一覧には表示せず、IDを直接指定した複製だけを許可できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| PATCH | /v1/\\{app_id}/config/visibility | \`visibility\`と任意の\`listed\`を設定 |

<span id="toggle-visibility"></span>

### 公開範囲の変更

\`\`\`json
PATCH /v1/{app_id}/config/visibility
Authorization: Bearer {token}

{ "visibility": "public" }
\`\`\`

応答：

\`\`\`json
{ "message": "Visibility updated to \\"public\\"", "app_id": "{app_id}", "visibility": "public", "listed": true }
\`\`\`

\`listed\`は任意です。\`true\`（公開アプリの既定値）なら公開テンプレート一覧に表示します。\`"listed": false\`なら、直接リンクから利用できる状態を保ちながら一覧では非表示にします。

\`visibility\`には\`"public"\`または\`"private"\`を指定します。既定値は\`"private"\`です。

<span id="read-current-visibility"></span>

### 現在の公開範囲の取得

\`GET /v1/{app_id}/config\`は、他のアプリ設定とともに\`visibility\`と\`listed\`を返します。

<span id="templates"></span>

## テンプレート

公開アプリのリポジトリのスナップショットを複製し、自分のプロジェクトの出発点にできます。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/templates | 公開アプリのテンプレートを検索（匿名） |
| GET | /v1/templates/\\{app_id} | 公開テンプレート1件の詳細を取得 |
| POST | /v1/templates/\\{source_app_id}/clone | 公開アプリの複製を開始。\`{ job_id }\`を返します。 |
| GET | /v1/clone-jobs/\\{job_id} | 複製ジョブの状態を取得 |
| POST | /v1/clone-jobs/\\{job_id}/retry | 失敗した複製ジョブを再試行 |

<span id="discover-public-templates"></span>

### 公開テンプレートの検索

\`GET /v1/templates\`は、全リージョンの公開かつ一覧表示が有効なアプリを返します。認証は不要です。\`q\`（名前の前方一致）、\`region\`、\`sort=recent|popular\`、\`limit\`（最大50）、\`offset\`に対応します。応答：\`{ items: [{ app_id, name, owner_display_name, region, created_at, fork_count, has_repo, schema_summary: { table_count, function_count } }], total, limit, offset }\`。

\`GET /v1/templates/{app_id}\`は、1つのテンプレートの詳細を返します。\`tables\`、\`functions\`、\`forks_sample\`（最新5件の複製）が含まれます。非公開または一覧非表示のアプリには404を返し、存在を知らせません。

<span id="clone-a-public-app"></span>

### 公開アプリの複製

\`POST /v1/templates/{source_app_id}/clone\`は、呼び出し元が所有するアプリを新規作成して複製します。本文：\`{ name?: string, region?: string }\`。リージョンの既定値は元のアプリと同じです。元のアプリは公開されている必要があり、非公開なら404を返して存在を知らせません。応答は\`{ job_id, status: "pending" }\`です。

\`GET /v1/clone-jobs/{job_id}\`を、\`status\`が\`"completed"\`（新しい\`dest_app_id\`を含む）または\`"failed"\`（\`error_message\`を含む）になるまでポーリングします。失敗したジョブは\`POST /v1/clone-jobs/{job_id}/retry\`で再試行できます。

**複製するもの：** データベースのスキーマ（テーブル、列、インデックス）、行レベルセキュリティのポリシー、関数コード、複製時点の最新リポジトリファイル、シークレットを含まない設定（ストレージ、許可するオリジン、OAuthプロバイダーとURL、既定のAIモデル）、作者が初期データとして指定したテーブルの行。

**複製しないもの：** エンドユーザーのアカウントとセッション、OAuthクライアントの認証情報、関数の環境変数、持ち込みのAIプロバイダーキー（BYOK）、カスタムドメイン、課金情報、関数の呼び出し履歴、監査ログ。複製したアプリの所有者が設定してください。詳細は[複製する内容](https://docs.butterbase.ai/ja/core-concepts/database/#what-a-clone-copies)を参照してください。

<span id="app-repo"></span>

## アプリのリポジトリ

コードを内容のハッシュで識別するスナップショットとしてアプリへ送信できます。複数の端末から利用するバックアップや、ファイルの基準となる保存先に使えます。変更のないファイルは再送信しません。最新5件のスナップショットを保持します。

リポジトリの内容はアプリのオブジェクトストレージの予約済みプレフィックス配下へ保存します。通常のストレージオブジェクトとは**別扱い**で、専用の2段階のアップロードを使います。

送信は2段階です。

1. \`prepare\`：ファイルのパス、sha256、サイズを含むマニフェストを送信します。サーバーが検証し、未保存のデータに対する署名付きPUT URLを返します。
2. \`commit\`：指定されたデータを返されたURLでS3へアップロードし、マニフェストを再送します。サーバーが全データのサイズを検証してマニフェストを保存し、\`latest\`を新しいスナップショットへ切り替えます。

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/repo/snapshots/prepare | マニフェストを検証し、未保存のデータ用の署名付きPUT URLを取得 |
| POST | /v1/\\{app_id}/repo/snapshots/commit | 全データのアップロード後にスナップショットを確定 |
| GET | /v1/\\{app_id}/repo/snapshots | スナップショットの履歴を取得（新しい順） |
| GET | /v1/\\{app_id}/repo/snapshots/latest | 現在のスナップショットのマニフェストを取得 |
| GET | /v1/\\{app_id}/repo/snapshots/\\{snapshot_id} | 指定したスナップショットのマニフェストを取得 |
| GET | /v1/\\{app_id}/repo/blobs/\\{sha256} | 1つのデータ用の署名付きGET URLを取得 |
| POST | /v1/\\{app_id}/repo/blobs/batch | 複数のデータ用のダウンロードURLをまとめて取得 |
| DELETE | /v1/\\{app_id}/repo | リポジトリを全削除 |

**公開**アプリの読み取り（\`GET\`）には認証が不要です。**非公開**アプリの読み書きは所有者だけに許可します。

<span id="manifest-shape"></span>

### マニフェストの形式

\`\`\`json
{
  "files": [
    { "path": "src/index.ts", "sha256": "<64 hex>", "size": 1234 }
  ],
  "message": "optional push message"
}
\`\`\`

パスは相対パスで、ASCIIの安全な文字だけを使います。\`..\`の要素、先頭の\`/\`、バックスラッシュ、ヌル文字を含められません。パスは最大4KB、ファイルは最大10MB、スナップショットは最大100MBです。

<span id="prepare"></span>

### 準備

\`\`\`json
POST /v1/{app_id}/repo/snapshots/prepare
Authorization: Bearer {token}

{ "files": [ { "path": "a.txt", "sha256": "...", "size": 5 } ] }
\`\`\`

応答：

\`\`\`json
{
  "snapshot_id": "<64 hex>",
  "total_bytes": 5,
  "file_count": 1,
  "missing_blobs": [ { "sha256": "...", "uploadUrl": "https://..." } ]
}
\`\`\`

各\`missing_blob.uploadUrl\`へ\`PUT\`でアップロードします。署名付きURLは10分で失効します。

<span id="commit"></span>

### 確定

\`\`\`json
POST /v1/{app_id}/repo/snapshots/commit
Authorization: Bearer {token}

{ "manifest": { "files": [ ... ], "message": "..." } }
\`\`\`

未保存のデータ、またはマニフェストとサイズが合わないデータがある場合、409と\`details.missing_shas\`、\`details.size_mismatches\`を返します。該当するデータを再アップロードしてから確定を再試行してください。

<span id="pull"></span>

### 取得

\`\`\`http
GET /v1/{app_id}/repo/snapshots/latest
\`\`\`

\`{ snapshot_id, manifest }\`を返します。マニフェストの各ファイルについて、\`GET /v1/{app_id}/repo/blobs/{sha256}\`で署名付きGET URL（有効期限1時間）を取得し、ダウンロードしてください。

<span id="wipe"></span>

### 全削除

\`DELETE /v1/{app_id}/repo\`は、全スナップショット、データ、\`latest\`の参照を削除します。元に戻せません。

<span id="snapshot-history"></span>

### スナップショットの履歴

\`GET /v1/{app_id}/repo/snapshots\`は、\`{ snapshots: [{ snapshot_id, created_at }] }\`を新しい順で返します。公開範囲のルールは\`latest\`と同じです。公開アプリは認証不要、非公開は所有者専用で、それ以外には404を返します。

<span id="batch-blob-presign"></span>

### 複数データの署名付きURL

\`POST /v1/{app_id}/repo/blobs/batch\`は\`{ shas: string[] }\`（最大1000件）を受け取り、\`{ blobs: [{ sha256, size, downloadUrl, expiresIn }] }\`を返します。存在しない、または削除済みのハッシュは応答に含まれないため、取得件数が指定件数より少ない場合があります。公開範囲は単一データのAPIと同じです。公開アプリは認証不要、非公開は所有者専用です。

多数のファイルを含むマニフェストを、ファイルごとの通信を減らして取得できます。MCPの\`manage_repo\`の\`pull_latest\`でも内部で使用します。

<span id="per-app-subdomains"></span>

## アプリごとのサブドメイン

サブドメインのルーティングが有効な場合、アプリの名前からサブドメインを作成します。\`https://{subdomain}.{base_domain}\`へのアクセスではHostヘッダーからアプリを解決するため、パスの\`{app_id}\`を省略できます。

| サブドメインのパス | 用途 |
|----------------|-------------------|
| /data/\\{table} | データAPIのCRUD |
| /fn/\\{function_name} | 関数を呼び出す |
| /auth/signup, /auth/login, ... | エンドユーザーの認証 |
| /storage/upload, /storage/objects, ... | ファイルストレージ |
| /schema, /schema/apply, /migrations | スキーマ管理 |

<span id="product-suggestions"></span>

## 製品への提案

**MCPツール：** \`submit_suggestion\`

**HTTP：**

\`\`\`json
POST /suggestions
Authorization: Bearer {api_key}

{
  "category": "feature_request",
  "description": "Add support for GraphQL subscriptions",
  "severity": "medium",
  "source": "human_prompted"
}
\`\`\`

| フィールド | 必須 | 値 |
|-------|----------|--------|
| \`category\` | はい | \`bug_report\`, \`feature_request\`, \`improvement\`, \`documentation\` |
| \`description\` | はい | 説明文 |
| \`severity\` | いいえ | \`low\`, \`medium\`, \`high\`, \`critical\` |
| \`affected_tool\` | いいえ | 該当する場合はツール名 |
| \`proposed_solution\` | いいえ | 修正案 |
| \`source\` | いいえ | \`agent\`または\`human_prompted\` |

<span id="health-checks"></span>

## ヘルスチェック

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /health | 稼働確認 |
| GET | /health/ready | 準備状況の確認（データベース接続） |

<span id="error-format"></span>

## エラーの形式

エラーはすべて構造化したオブジェクトを含みます。

\`\`\`json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Table 'nonexistent' does not exist",
    "remediation": "Check the table name and ensure it exists in your schema",
    "documentation_url": "https://docs.butterbase.ai/api-reference/data-api"
  }
}
\`\`\`

再試行する前に\`remediation\`の内容に従ってください。

<span id="rate-limiting"></span>

## レート制限

認証などの機密性の高いエンドポイントには厳しい個別のレート制限があります。他のエンドポイントにも、環境の設定に応じて制限が適用される場合があります。

---

全フロントエンドに無料の\`*.pages.dev\` URLを割り当てます。**カスタムドメイン**を設定すると、自分の\`app.example.com\`やルートの\`example.com\`でも配信でき、SSL証明書はButterbaseが発行・更新します。

**Launch以上**のプランで利用できます。

<span id="how-it-works"></span>

## 仕組み

Cloudflare for SaaSを使い、ホスト名追加時に次を行います。

1. Cloudflareのcustom hostnameとして登録し、アプリへ紐付け。
2. エッジが対象アプリを特定できるKV対応表を作成。
3. DNSを指定先へ向け、所有権を検証。
4. Cloudflareが証明書を発行し、自動で更新。

DNSの管理は自分で続けられます。ドメインをCloudflareへ移す必要はありません。

<span id="requirements"></span>

## 必要条件

| 条件 | 理由 |
|---|---|
| Launch以上のプラン | \`custom_domain\`機能で制御。Playgroundは\`403\`。 |
| アプリがドメインを所有 | ホスト名は全体で一意。同じ名前を別アプリが追加すると\`409\`。 |
| 公開済みフロントエンド | アプリの現在の配信先へ接続。ドメインだけ先に追加も可能だが、配信内容はまだない。 |
| WfPのデプロイ基盤 | 旧基盤では\`400\`。新規アプリはWfP。 |
| DNS設定の権限 | CNAMEとTXTを作成できること。 |

<span id="step-1--pick-a-validation-method"></span>

## 手順1 — 検証方法を選択

\`validation_method\`は証明書発行前の所有権確認方法です。選択の誤りはpendingが続く主な原因になります。

| 方法 | 仕組み | 適する場合 | 避ける場合 |
|---|---|---|---|
| \`http\`（既定） | Cloudflareが検証ファイルを配信。必要なのは接続用CNAMEだけ。 | サブドメイン、Cloudflare以外のDNS。 | Cloudflareの**プロキシ有効**ゾーンや**Cloudflare上のルートドメイン**。プロキシが検証を妨げ、CNAME flatteningでレコードも見えなくなる。 |
| \`txt\` | Cloudflareが返すTXTをDNSへ追加。 | Cloudflareのルートドメイン、プロキシ有効ゾーン、確実な方法を選びたい場合。 | — |

目安は、**一般のDNS上のサブドメインならhttp、Cloudflare上またはルートドメインならtxt**です。

<span id="step-2--add-the-domain"></span>

## 手順2 — ドメインを追加

**ダッシュボード：App → Settings → Custom domains → Add domain**。

**CLI:**

\`\`\`bash
butterbase domains add app.example.com
butterbase domains add example.com --validation-method txt
\`\`\`

**REST API:**

\`\`\`
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{ "hostname": "app.example.com", "validation_method": "http" }
\`\`\`

**MCP:**

\`\`\`
manage_frontend({
  app_id: "app_abc123",
  action: "configure_custom_domain",
  domain_action: "add",
  hostname: "app.example.com"
})
\`\`\`

\`201\`レスポンスには次の手順に必要な情報が入ります。

\`\`\`json
{
  "domain": { "id": "…", "hostname": "app.example.com", "status": "pending", "ssl_status": "pending" },
  "cname_target": "butterbase.dev",
  "validation_method": "http",
  "verification_records": [{ "txt_name": "_acme-challenge.app.example.com", "txt_value": "…" }],
  "ownership_verification": null,
  "instructions": "Add a CNAME record at your DNS provider: …"
}
\`\`\`

状態確認・再検証・削除で使うdomain.idを保存してください。

<span id="step-3--add-your-dns-records"></span>

## 手順3 — DNSを設定

<span id="if-you-chose-http"></span>

### httpの場合

1つのレコードを追加します。

| 種類 | 名前 | 値 |
|---|---|---|
| CNAME | \`app.example.com\` | \`butterbase.dev\` |

:::caution
**Cloudflare DNSではDNS-only（灰色の雲）を指定してください。** 別Cloudflareアカウントへのプロキシ有効CNAME（オレンジの雲）は**Error 1014**になり動作しません。
:::

<span id="if-you-chose-txt"></span>

### txtの場合

2つ、場合によって3つのレコードを追加します。

| # | 種類 | 名前 | 値 |
|---|---|---|---|
| 1 | CNAME | \`app.example.com\` | \`butterbase.dev\` — ルートではプロバイダー対応の形式を使用（Cloudflareのflattened CNAMEも可） |
| 2 | TXT | \`verification_records[].txt_name\` | \`verification_records[].txt_value\` — 証明書を認可 |
| 3 | TXT | \`ownership_verification.name\` | \`ownership_verification.value\` — Cloudflareプロキシのゾーン**だけ**で返る。返された場合は追加 |

verification_recordsが空なら、まだCloudflareが生成していません。1分後に状態APIを呼んでください。

<span id="step-4--watch-it-go-active"></span>

## 手順4 — 有効化を確認

\`\`\`bash
butterbase domains status <domain-id>
\`\`\`

\`\`\`
GET /v1/{app_id}/custom-domains/{domain_id}/status
\`\`\`

毎回Cloudflareの状態を読み直して保存するため、現在の状態を返します。

\`\`\`json
{
  "domain": {
    "hostname": "app.example.com",
    "status": "active",
    "ssl_status": "active",
    "verification_errors": null
  },
  "cname_target": "butterbase.dev",
  "verification_records": [],
  "ownership_verification": null
}
\`\`\`

| フィールド | 意味 |
|---|---|
| \`status\` | ホスト名の状態。pendingはDNS・検証待ち、activeは配信可能。 |
| \`ssl_status\` | 証明書の状態。pending／initializing／pending_validationは発行中、activeはHTTPS利用可能。 |
| \`verification_errors\` | 検証拒否の理由。進まない場合はまず確認。 |

**statusとssl_statusがともにactiveになると公開完了**です。通常5〜15分で、DNS反映が時間の多くを占めます。

止まっている場合、ドメインを再作成せず検証を再実行できます。元のvalidation_methodは保持します。

\`\`\`bash
butterbase domains verify <domain-id>
\`\`\`

\`\`\`
POST /v1/{app_id}/custom-domains/{domain_id}/verify
\`\`\`

<span id="apex-vs-www"></span>

## ルートドメインとwww

Butterbaseは両者を強制リダイレクトしません。どちらも通常のホスト名で、正規URLにできます。

- 正規URLを決め、そのドメインを追加します。
- 他方はDNSプロバイダーのエッジで転送します（Cloudflare Redirect Rules、Netlify／Vercel、レジストラーのALIASとルールなど）。
- Cloudflareのルートは\`validation_method: "txt"\`が必要です。他社のCNAME flattening対応DNSならhttpも使えます。
- flattening非対応ならwww.example.comを設定し、ルートから転送します。

<span id="managing-domains"></span>

## ドメイン管理

| メソッド | パス | MCP domain_action | 用途 |
|--------|------|---------------------|---------|
| POST | \`/v1/{app_id}/custom-domains\` | \`add\` | ホスト名を追加（validation_method指定可） |
| GET | \`/v1/{app_id}/custom-domains\` | \`list\` | アプリの全ホスト名を取得 |
| GET | \`/v1/{app_id}/custom-domains/{id}/status\` | \`status\` | 現在の検証・SSL状態 |
| POST | \`/v1/{app_id}/custom-domains/{id}/verify\` | \`verify\` | 再検証 |
| DELETE | \`/v1/{app_id}/custom-domains/{id}\` | \`remove\` | ホスト名を削除 |

\`\`\`bash
butterbase domains list
butterbase domains add <hostname> [--validation-method http|txt]
butterbase domains status <domain-id>
butterbase domains verify <domain-id>
butterbase domains delete <domain-id> [--yes]
\`\`\`

\`\`\`typescript
await bb.admin.domains.list();
await bb.admin.domains.add('app.example.com', 'txt');
await bb.admin.domains.getStatus(domainId);
await bb.admin.domains.verify(domainId);
await bb.admin.domains.remove(domainId);
\`\`\`

:::caution
削除するとそのホスト名への配信を即座に停止します。DNSを別の宛先へ変えるまで、訪問者にはエラーを表示します。
:::

<span id="troubleshooting"></span>

## 問題の対処

| 症状 | 原因 | 対処 |
|---|---|---|
| 追加時403 | 組織のプランにcustom_domainがない | [プランと使用量](https://docs.butterbase.ai/ja/core-concepts/plans-and-usage/)から更新 |
| 409 already registered | 同じアプリか別アプリが登録済み | 同じアプリなら状態確認。別なら名前を変更 |
| 基盤について400 | 旧デプロイ基盤 | 先にWfPへ移行 |
| 503 Cloudflare is not configured | セルフホストで認証情報が未設定 | Control APIのCloudflare設定を確認 |
| ブラウザのError 1014 | アカウントをまたぐプロキシCNAME | DNS-onlyへ変更 |
| ルートでpendingが続く | Cloudflareのゾーンでhttpを使用 | 削除してtxtで再登録 |
| statusはactive、ssl_statusが進まない | TXT検証レコードが不正か欠落 | 状態APIのverification_recordsで修正しverify |
| 古いサイトが表示 | 再公開後のエッジキャッシュ | 数分待ち、強制再読み込み。[デプロイ](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/)を参照 |

<span id="related"></span>

## 関連ページ

- [フロントエンドのデプロイ](https://docs.butterbase.ai/ja/core-concepts/frontend-deployment/) — 公開の基本
- [エッジSSR](https://docs.butterbase.ai/ja/core-concepts/edge-ssr-deployment/) — サーバーレンダリング
- [プランと使用量](https://docs.butterbase.ai/ja/core-concepts/plans-and-usage/) — 対応プラン
- 複製先にはカスタムドメインを引き継ぎません。[複製先の設定](https://docs.butterbase.ai/ja/templates/configure/)を参照`,
  regions: `アプリを作成するときにリージョンを選びます。データベース、ファイル、関数はその場所に置き、利用者に近い環境で処理します。クライアントは共通のAPI URLを使い続け、Butterbaseが自動で振り分けます。

<span id="available-regions"></span>

## 対応リージョン

| リージョン | コード |
|---|---|
| 米国東部 | \`us-east-1\` |
| 米国西部 | \`us-west-2\` |

今後リージョンを追加予定です。希望する地域があれば[ご連絡ください](mailto:hello@butterbase.ai)。

<span id="fetching-the-live-list"></span>

### 最新の一覧を取得

対応リージョンはAPIから取得できます。選択画面の作成や、\`init_app\`または\`manage_app\`（action：\`"move"\`）前のスラッグ検証に使えます。

**MCP**

\`\`\`
list_regions()
\`\`\`

**REST**

\`\`\`bash
curl https://api.butterbase.ai/v1/regions
# → { "regions": ["us-east-1", "us-west-2"] }
\`\`\`

このエンドポイントは公開されており、APIキーは不要です。

<span id="picking-a-region-when-you-create-an-app"></span>

## アプリ作成時に選ぶ

リージョンの指定は任意です。省略すると既定のリージョンに作成します。

**MCP**

\`\`\`
init_app({ name: "my-app", region: "us-west-2" })
\`\`\`

**CLI**

\`\`\`bash
butterbase apps create my-app --region us-west-2
\`\`\`

**REST**

\`\`\`bash
curl -X POST https://api.butterbase.ai/init \\
  -H "Authorization: Bearer $BUTTERBASE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "my-app", "region": "us-west-2"}'
\`\`\`

<span id="what-lives-in-a-region"></span>

## リージョン内に置くもの

各アプリは拠点となるリージョンを1つ持ち、次を保存・実行します。

- データベース
- サーバーレス関数
- ファイルストレージ
- エンドユーザーのアカウントとセッション

次はグローバルで、リージョン選択の影響を受けません。

- API URL：\`https://api.butterbase.ai\`をどこからでも利用
- フロントエンド：グローバルのエッジネットワークから配信
- Butterbaseのアカウント、課金、ダッシュボード

<span id="one-url-anywhere"></span>

## どこでも1つのURL

フロントエンドとSDKは常に\`https://api.butterbase.ai\`を使います。リージョン固有URLを指定する必要はなく、移動時も変更不要です。適切なリージョンへリクエストを振り分けます。

<span id="moving-an-app-to-another-region"></span>

## 別リージョンへ移動

利用者の地域が変わった場合や、別の地域へ近づけたい場合はアプリを移動できます。

**MCP**

\`\`\`
manage_app({ action: "move", app_id: "app_abc123", dest_region: "us-east-1" })
\`\`\`

**CLI**

\`\`\`bash
butterbase apps move app_abc123 --to us-east-1
\`\`\`

移動中も読み取りは可能です。切り替え時に書き込みを短時間停止し、完了後に自動再開します。通常は数分で終わりますが、データ量によって変わります。

進捗はいつでも確認できます。

\`\`\`
manage_app({ action: "move_status", app_id: "app_abc123", migration_id: "<id from move>" })
\`\`\`

同じアプリの移動が進行中の場合、別の移動は開始できません。

<span id="choosing-a-region"></span>

## 選ぶときの考え方

次を検討してください。

- **利用者の所在地。** 多数のユーザーに最も近いリージョンを選びます。ユーザーとデータベース間の往復遅延は、体感速度に大きく影響します。
- **データの保存地域。** 特定の法域に保存する必要があれば、その地域を選びます。未提供の地域が必要ならお問い合わせください。
- **後から変更可能。** 最初のリージョンに固定されません。用途が変われば移動できます。

迷う場合は指定を省略すると、Butterbaseが既定値を選びます。後から移動できます。`,
  schema: `宣言的なJSONでデータベースを定義します。望む状態を記述すると、必要な変更を計算して適用します。

作成時に選んだ[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)に保存します。利用者の地域が変われば後から移動できます。

<span id="basic-structure"></span>

## 基本構造

\`\`\`json
{
  "schema": {
    "tables": {
      "table_name": {
        "columns": {
          "column_name": {
            "type": "text",
            "primary": true,
            "nullable": false,
            "unique": true,
            "default": "gen_random_uuid()",
            "references": { "table": "other_table", "column": "id" }
          }
        },
        "indexes": {
          "idx_name": {
            "columns": ["col1", "col2"],
            "unique": false
          }
        }
      }
    }
  },
  "dry_run": false,
  "name": "descriptive migration name"
}
\`\`\`

<span id="column-properties"></span>

## 列の属性

| 属性 | 型 | 必須 | 説明 |
|----------|------|----------|-------------|
| \`type\` | string | はい | 列のデータ型 |
| \`primary\` | boolean | いいえ | 主キーにする |
| \`nullable\` | boolean | いいえ | NULLを許可（既定true） |
| \`unique\` | boolean | いいえ | 一意制約を追加 |
| \`default\` | string | いいえ | 既定値の式（now()、gen_random_uuid()など） |
| \`references\` | string \\| object | いいえ | 外部キー。table.columnか\`{table, column, onDelete?, onUpdate?}\`。 |

<span id="supported-column-types"></span>

## 対応する型

| 分類 | 型 |
|----------|-------|
| **文字列** | \`text\`、\`varchar\`、\`varchar(N)\`、\`char\`、\`char(N)\` |
| **数値** | \`integer\`、\`bigint\`、\`smallint\`、\`real\`、\`float4\`、\`float8\`、\`decimal\`、\`numeric\`、\`numeric(P,S)\` |
| **真偽値** | \`boolean\`、\`bool\` |
| **UUID** | \`uuid\` |
| **日時** | \`timestamp\`、\`timestamptz\`、\`date\`、\`time\`、\`timetz\`、\`interval\` |
| **JSON** | \`json\`, \`jsonb\` |
| **バイナリ** | \`bytea\` |
| **ベクトル** | \`vector(N)\`。Nは次元数（AI埋め込み用） |
| **配列** | \`text[]\`、\`integer[]\`など |

<span id="common-patterns"></span>

## よく使うパターン

<span id="basic-table-with-auto-generated-id"></span>

### 自動IDの基本テーブル

\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

<span id="table-with-foreign-key-and-user-ownership"></span>

### 外部キーとユーザー所有権

\`\`\`json
{
  "tables": {
    "comments": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "post_id": { "type": "uuid", "nullable": false, "references": { "table": "posts", "column": "id", "onDelete": "CASCADE" } },
        "user_id": { "type": "uuid", "nullable": false },
        "body": { "type": "text", "nullable": false },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "indexes": {
        "idx_comments_post": { "columns": ["post_id"] },
        "idx_comments_user": { "columns": ["user_id"] }
      }
    }
  }
}
\`\`\`

作成後、manage_rlsにcreate_user_isolation、table_name: comments、user_column: user_idを指定してユーザー単位で分離します。

<span id="foreign-keys-with-referential-actions"></span>

### 外部キーの参照アクション

referencesは同等の2形式を受け付けます。

**文字列** — onDeleteとonUpdateはNO ACTIONになります。

\`\`\`json
"author_id": { "type": "uuid", "references": "users.id" }
\`\`\`

**オブジェクト** — アクションを明示できます。

\`\`\`json
"author_id": {
  "type": "uuid",
  "references": {
    "table": "users",
    "column": "id",
    "onDelete": "CASCADE",
    "onUpdate": "NO ACTION"
  }
}
\`\`\`

**onDelete・onUpdateに指定する値：**

| 値 | 参照行を削除・更新したときの動作 |
|-------|---------------------------------------------------|
| \`NO ACTION\`（既定） | 依存行があれば拒否（遅延評価可） |
| \`RESTRICT\` | 遅延せず即座に拒否 |
| \`CASCADE\` | 依存行にも同じ操作を適用 |
| \`SET NULL\` | 外部キーをNULLにする（nullableが必要） |
| \`SET DEFAULT\` | 宣言した既定値へ変更 |

ユーザー削除で投稿も削除する例：

\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "author_id": {
          "type": "uuid",
          "nullable": false,
          "references": { "table": "users", "column": "id", "onDelete": "CASCADE" }
        },
        "title": { "type": "text", "nullable": false }
      }
    }
  }
}
\`\`\`

<span id="table-with-vector-column-for-ai-embeddings"></span>

### ベクトル列（AI埋め込み）

\`\`\`json
{
  "tables": {
    "documents": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "content": { "type": "text" },
        "embedding": { "type": "vector(1536)" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

<span id="adding-columns-to-existing-tables"></span>

## 既存テーブルへの列追加

既存列と新しい列を含めて定義します。差分だけを適用します。

\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "published": { "type": "boolean", "default": "false" },
        "image_url": { "type": "text" },
        "view_count": { "type": "integer", "default": "0" },
        "created_at": { "type": "timestamptz", "default": "now()" },
        "updated_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

既存列を変えずimage_urlとview_countを追加します。

<span id="dropping-columns"></span>

## 列の削除

_dropColumnsへ削除する列を明示します。

\`\`\`json
{
  "tables": {
    "posts": {
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "title": { "type": "text", "nullable": false },
        "body": { "type": "text" },
        "created_at": { "type": "timestamptz", "default": "now()" }
      },
      "_dropColumns": ["published", "image_url"]
    }
  }
}
\`\`\`

<span id="dropping-tables"></span>

## テーブル削除

_drop: trueでテーブル全体を削除します。

\`\`\`json
{
  "tables": {
    "old_table": {
      "_drop": true
    }
  }
}
\`\`\`

<span id="marking-tables-as-seed-data"></span>

## シードデータの指定

_seed: trueを指定すると、テンプレートの複製時に行もコピーします。

\`\`\`json
{
  "tables": {
    "roles": {
      "_seed": true,
      "columns": {
        "id": { "type": "uuid", "primary": true, "default": "gen_random_uuid()" },
        "name": { "type": "text", "nullable": false, "unique": true },
        "created_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
\`\`\`

適用・取得の繰り返しでも指定は保持します。参照テーブル、既定ロール、例示用の行などに使い、複製先に必要な初期データを用意します。

シード指定の行を新DBへコピーします。未指定はスキーマだけで、行はコピーしません。

<span id="what-a-clone-copies"></span>

## 複製する内容

新しいアプリへ次をコピーします。

- スキーマ（テーブル、列、インデックス）
- RLSポリシー
- 関数コード
- 複製時点の最新ファイル
- シークレット以外の設定（ストレージ、CORS、OAuthの種類・URL、AIモデル）
- _seed: trueの行
- 最新フロントエンド。IDを新しいアプリへ置換（未公開なら省略、失敗時は警告）

<span id="what-stays-with-you"></span>

## 元のアプリに残るもの

次は引き継ぎません。

- ユーザーアカウントとセッション
- OAuthのクライアント認証情報
- 関数の環境変数の値
- BYOK AIキー
- カスタムドメイン
- 課金設定
- 呼び出し履歴
- 監査ログ

完了後に新しい所有者が設定します。[複製先の設定](https://docs.butterbase.ai/ja/templates/configure/)を参照してください。

<span id="clone-regions"></span>

## 複製先のリージョン

[対応リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)から選べます。地域をまたぐ場合、ファイルの転送で少し長くかかることがあります。

<span id="dry-run-preview-changes"></span>

## Dry run（変更の事前確認）

破壊的な変更は先に確認してください。

\`\`\`json
{
  "schema": { "tables": { "..." : {} } },
  "dry_run": true
}
\`\`\`

実行せずSQLを返します。確認後にdry_run: falseか省略で適用します。

<span id="auto-generated-data-api"></span>

## 自動生成するデータAPI

テーブルが存在すればREST APIを利用できます。コード生成は不要です。[REST API](https://docs.butterbase.ai/ja/sdks-and-tools/rest-api/)を参照してください。

<span id="safety"></span>

## 安全性

- **削除は既定で拒否。** _dropや_dropColumnsを明示してください。
- **定義の上限：** 50テーブル。
- **冪等：** 同じ定義の再適用では変更せず、差分だけ処理。

<span id="database-architecture"></span>

## データベース構成

データプレーンに専用のPostgreSQL（app_{id}）を用意し、次を初期設定します。

- 埋め込み用pgvector
- UUID用uuid-ossp
- RLS用current_user_id()
- マイグレーションの履歴

---

行レベルセキュリティ（RLS）は、ユーザーがアクセスできる行を制御します。PostgreSQL内蔵の仕組みを使い、リクエストの認証方式に応じて自動適用します。

<span id="built-in-roles"></span>

## 組み込みロール

Authorizationヘッダーで**自動判定**するロールが3つあります。自分で作成・設定する必要はありません。

| リクエストの種類 | Authorizationヘッダー | 割り当てるロール |
|---|---|---|
| 認証ヘッダーなし | なし | butterbase_anon |
| エンドユーザーJWT | \`Bearer {end_user_jwt}\` | butterbase_user |
| プラットフォームAPIキー | \`Bearer {platform_api_key}\` | butterbase_service |

**butterbase_anon** — ポリシーで許可した公開データだけにアクセスします。商品一覧や公開プロフィールに使います。

**butterbase_user** — ユーザー固有データにアクセスします。\`current_user_id()\`は認証済みユーザーIDを返し、ダッシュボードや個人データに使います。

**butterbase_service** — 全データへのアクセスを許可します。RLSを有効にした各テーブルにサービス用の許可ポリシーを自動作成します。

<span id="one-tool-three-common-actions"></span>

## 1つのツールで行う3つの主な操作

\`manage_rls\`の\`action\`で全RLS操作を選びます（\`enable\`、\`create_policy\`、\`update_policy\`、\`create_user_isolation\`、\`list\`、\`delete\`）。

<span id="1-enable--foundation"></span>

### 1. enable — 基本設定

テーブルでRLSを有効にし、サービス用許可ポリシーを自動作成します。

\`\`\`
manage_rls({ action: "enable", app_id: "app_abc123", table_name: "posts" })
\`\`\`

<span id="2-create_user_isolation--simple"></span>

### 2. create_user_isolation — 簡単な分離

1回で、ユーザーが自分のデータだけを見る設定を行います。

\`\`\`
manage_rls({
  action: "create_user_isolation",
  app_id: "app_abc123",
  table_name: "posts",
  user_column: "user_id"
})
\`\`\`

自動で次を設定します。
- RLSを有効化
- butterbase_userに限定したユーザー分離ポリシー
- INSERT時にユーザー列を自動設定するトリガー
- サービス用許可ポリシー

<span id="3-create_policy--power-user"></span>

### 3. create_policy — 詳細な制御

USINGとWITH CHECK式を自由に設定できます。

\`\`\`
manage_rls({
  action: "create_policy",
  app_id: "app_abc123",
  table_name: "products",
  policy_name: "public_read_products",
  command: "SELECT",
  role: "anon",
  using_expression: "active = true AND published = true"
})
\`\`\`

**コマンドごとの式：**

| コマンド | USING | WITH CHECK |
|---------|-------|------------|
| SELECT | 必要 | 不要 |
| INSERT | 不要 | 必要 |
| UPDATE | 両方 | 両方 |
| DELETE | 必要 | 不要 |
| ALL | 両方 | 両方 |

<span id="policy-examples"></span>

## ポリシーの例

<span id="public-read-access-anonymous-users"></span>

### 公開読み取り（匿名ユーザー）

\`\`\`
manage_rls({
  action: "create_policy",
  policy_name: "public_read_products",
  command: "SELECT",
  role: "anon",
  using_expression: "active = true AND published = true"
})
\`\`\`

<span id="user-specific-access-authenticated-users"></span>

### ユーザー固有のアクセス（認証済み）

簡単な方法：
\`\`\`
manage_rls({
  action: "create_user_isolation",
  table_name: "orders",
  user_column: "user_id"
})
\`\`\`

独自に定義する方法：
\`\`\`
manage_rls({
  action: "create_policy",
  policy_name: "users_own_orders",
  command: "ALL",
  role: "user",
  using_expression: "user_id = current_user_id()"
})
\`\`\`

<span id="insert-policy-user-can-only-insert-their-own-rows"></span>

### INSERTポリシー（自分の行だけ作成）

\`\`\`
manage_rls({
  action: "create_policy",
  policy_name: "users_insert_own",
  command: "INSERT",
  role: "user",
  with_check_expression: "user_id = current_user_id()::uuid"
})
\`\`\`

<span id="mixed-access-public-read-user-write"></span>

### 公開読み取りとユーザー書き込み

1. RLSを有効化：\`manage_rls({ action: "enable", table_name: "products" })\`
2. 公開読み取り：\`manage_rls({ action: "create_policy", command: "SELECT", role: "anon", using_expression: "active = true" })\`
3. 認証済みの書き込み：\`manage_rls({ action: "create_policy", command: "INSERT", role: "user", with_check_expression: "user_id = current_user_id()" })\`

<span id="role-scoping"></span>

## ロールの限定

意図しないロールにポリシーを適用しないよう、必ず\`role\`を指定します。
- \`role: "anon"\` — 未認証リクエストだけに適用
- \`role: "user"\` — 認証済みエンドユーザーだけに適用

限定しないと全ロールへ適用し、意図せずデータを公開する可能性があります。

<span id="helper-functions"></span>

## 補助関数

- **current_user_id()** — 認証済みユーザーIDをTEXTで返します。必要なら\`current_user_id()::uuid\`へ変換します。匿名ユーザーではNULLです。

<span id="auto-populate-trigger"></span>

## 自動入力トリガー

\`create_user_isolation\`、または\`user_column\`を指定した\`create_policy\`だけが、ユーザー列を埋めるBEFORE INSERTトリガーを作ります。トリガーがなければクライアントのPOST本文にユーザー列を含めてください。

<span id="common-pitfall-cross-table-subqueries"></span>

## よくある問題：別テーブルのサブクエリ

USING・WITH CHECKのどちらでも、許可・制限のどちらでも、\`EXISTS (SELECT 1 FROM other_table WHERE …)\`や\`column IN (SELECT … FROM other_table)\`を含む式は、同じ呼び出しロールで**参照先テーブル自身のRLS**を通して読みます。対象行が見えなければ、外側の式もfalseになり、書き込みは\`AUTH_RLS_POLICY_VIOLATION\`、読み取りは空になります。一見trueになる式でも同じです。

主な原因は3つあります。

<span id="1-referenced-table-has-rls-enabled-but-no-permissive-user-policy"></span>

### 1. 参照先でRLSが有効だがuser向け許可がない

RLSが有効なテーブルでは、明示的な許可がなければ\`butterbase_user\`からは0行に見えます。実在するUUIDを使った\`EXISTS (SELECT 1 FROM institutions WHERE id = '<real uuid>')\`もfalseになります。

対処：サブクエリに必要な行への読み取りを許可します。

\`\`\`
manage_rls({
  action: "create_policy",
  table_name: "institutions",
  policy_name: "institutions_user_read",
  command: "SELECT",
  role: "user",
  using_expression: "true"   // or a narrower predicate
})
\`\`\`

<span id="2-referenced-table-has-user_isolation--cross-user-reads-blocked"></span>

### 2. 参照先のユーザー分離で他人の行が見えない

ユーザーBがAの公開投稿へコメントする例では、commentsのポリシーが\`EXISTS (SELECT 1 FROM posts WHERE id = post_id AND is_public = true)\`を確認します。しかしpostsがユーザー分離されていると、BからAの行が見えずINSERTが拒否されます。

対処：参照先で\`create_user_isolation\`に\`public_read_column: "is_public"\`を指定するか、公開行に限定したSELECT許可ポリシーを追加します。

<span id="3-subquery-joins-on-a-column-different-from-the-isolation-column"></span>

### 3. 参照する列とユーザー分離の列が違う

usersを\`id = current_user_id()::uuid\`で分離していて、セッションのsubが別のauth_user_id（OAuthコールバックで独自IDを生成する場合など）だとします。checkpointsのポリシーが\`EXISTS (SELECT 1 FROM users WHERE u.id = checkpoints.student_id AND u.auth_user_id = current_user_id()::uuid)\`を確認しても、先にidで絞られた行のauth_user_idは一致せず、結果が空になります。

対処：参照先の分離列をセッションIDの対応先と合わせます。subがOAuthのauth_user_idなら次を実行します。

\`\`\`
manage_rls({
  action: "create_user_isolation",
  table_name: "users",
  user_column: "auth_user_id"   // not "id"
})
\`\`\`

<span id="quick-diagnosis"></span>

### 簡単な診断

通るはずのINSERTで\`AUTH_RLS_POLICY_VIOLATION\`が出たら、同じユーザーとして参照先にサブクエリ部分を実行します（\`select_rows\`に\`as_role: "user", as_user: <uuid>\`を指定）。0行なら、WITH CHECKの不具合ではなく、参照先のポリシーが原因です。

## REST API

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\\{app_id}/rls/enable | RLSを有効化 |
| POST | /v1/\\{app_id}/rls/policies | 独自ポリシーを作成 |
| POST | /v1/\\{app_id}/rls | ユーザー分離を設定 |
| GET | /v1/\\{app_id}/rls | 全ポリシーを一覧取得 |
| DELETE | /v1/\\{app_id}/rls/\\{table} | RLSを無効化 |`,
  sdk: `Butterbaseの公式TypeScript SDKです。ブラウザー、Node.js、Denoで動きます。

<span id="installation"></span>

## インストール

\`\`\`bash
npm install @butterbase/sdk
\`\`\`

<span id="quick-start"></span>

## クイックスタート

\`\`\`typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  anonKey: 'your-anon-key' // Optional, for public access
});
\`\`\`

アプリの[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)にかかわらず\`apiUrl\`は同じです。適切なリージョンへ自動で転送するため、移動後も変更は不要です。

<span id="data-operations"></span>

## データ操作

<span id="query"></span>

### 取得

\`\`\`typescript
const { data, error } = await butterbase
  .from('posts')
  .select('*')
  .eq('status', 'published')
  .order('created_at', { ascending: false })
  .limit(10);
\`\`\`

<span id="insert"></span>

### 追加

\`\`\`typescript
const { data, error } = await butterbase
  .from('posts')
  .insert({ title: 'Hello World', content: 'My first post' });
\`\`\`

<span id="update"></span>

### 更新

\`\`\`typescript
const { data, error } = await butterbase
  .from('posts')
  .update({ status: 'archived' })
  .eq('id', '123');
\`\`\`

<span id="delete"></span>

### 削除

\`\`\`typescript
const { data, error } = await butterbase
  .from('posts')
  .delete()
  .eq('id', '123');
\`\`\`

<span id="query-operators"></span>

## クエリの演算子

| メソッド | 対応するSQL |
|--------|---------------|
| \`eq(column, value)\` | \`=\` |
| \`neq(column, value)\` | \`!=\` |
| \`gt(column, value)\` | \`>\` |
| \`gte(column, value)\` | \`>=\` |
| \`lt(column, value)\` | \`<\` |
| \`lte(column, value)\` | \`<=\` |
| \`like(column, pattern)\` | \`LIKE\`（大文字と小文字を区別） |
| \`ilike(column, pattern)\` | \`ILIKE\`（大文字と小文字を区別しない） |
| \`in(column, values)\` | \`IN (...)\` |
| \`is(column, value)\` | \`IS NULL / TRUE / FALSE\` |

<span id="query-modifiers"></span>

## クエリの調整

| メソッド | 説明 |
|--------|-------------|
| \`select(columns)\` | 指定した列を取得 |
| \`order(column, options)\` | 結果を並び替え |
| \`limit(count)\` | 取得件数を制限 |
| \`offset(count)\` | 指定件数を読み飛ばす |

<span id="authentication"></span>

## 認証

セッションは\`localStorage\`へ自動保存し、ページの再読み込みで復元します。アクセストークンは期限前に自動更新します。

\`\`\`typescript
// Sign up
const { data, error } = await butterbase.auth.signUp({
  email: 'user@example.com',
  password: 'secure123'
});

// Sign in
const { data, error } = await butterbase.auth.signIn({
  email: 'user@example.com',
  password: 'secure123'
});

// Get current user
const { data: user } = await butterbase.auth.getUser();

// Sign out
await butterbase.auth.signOut();

// Refresh session manually
const { data } = await butterbase.auth.refreshSession();

// OAuth
const { url } = butterbase.auth.signInWithOAuth({
  provider: 'google',
  redirectTo: 'http://localhost:3000/callback'
});
window.location.href = url;
\`\`\`

<span id="magic-link-sign-in"></span>

### マジックリンクでのログイン

\`\`\`typescript
// Send a 6-digit code by email. Same response whether or not the email exists.
await butterbase.auth.sendMagicLink('user@example.com');

// Exchange the code for tokens. New users are auto-created on first verify.
const { data, error } = await butterbase.auth.verifyMagicLink('user@example.com', '123456');
if (data) {
  // data.access_token, data.refresh_token, data.user
}
\`\`\`

コードは6桁で、15分間有効かつ1回限りです。[マジックリンク](https://docs.butterbase.ai/ja/core-concepts/authentication/#magic-link-sign-in)を参照してください。

<span id="auth-state-changes"></span>

## 認証状態の変更

\`\`\`typescript
const { unsubscribe } = butterbase.onAuthStateChange((event, session) => {
  // event: 'SIGNED_IN' | 'SIGNED_OUT' | 'TOKEN_REFRESHED' | 'SESSION_RESTORED'
  console.log(event, session?.user);
});
\`\`\`

<span id="custom-session-storage"></span>

## 独自のセッション保存先

\`\`\`typescript
// Disable persistence
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  persistSession: false,
});

// Custom adapter (e.g. React Native)
const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
  sessionStorage: myCustomStorage, // implements { getItem, setItem, removeItem }
});
\`\`\`

<span id="storage"></span>

## ストレージ

\`\`\`typescript
const { data, error } = await butterbase.storage.upload(file);
const { data } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);
\`\`\`

<span id="functions"></span>

## 関数

\`\`\`typescript
const { data, error } = await butterbase.functions.invoke('my-function', {
  body: { key: 'value' },
  method: 'POST'
});
\`\`\`

<span id="substrate-stream"></span>

## Substrateのストリーム

[Substrate](https://docs.butterbase.ai/ja/core-concepts/substrate/)の変更をWebSocketで購読します。\`bb.substrate.stream\`が接続と再試行を行い、変更ごとにコールバックを呼び出します。フレームは\`{ org, op, tbl, id }\`だけで、行はIDから再取得します。

\`\`\`typescript
const sub = butterbase.substrate.stream({
  token: process.env.BUTTERBASE_SUBSTRATE_KEY, // bb_sub_… or bb_sk_…
  onChange: (evt) => {
    // evt: { org, op: 'insert' | 'update' | 'delete', tbl, id }
    if (evt.tbl === 'entities') refetchEntity(evt.id);
  },
  onStatus: (s) => console.log(s), // 'connecting' | 'open' | 'closed'
});

// stop listening
sub.unsubscribe();
\`\`\`

サーバー・スクリプト用の\`token\`（Substrateキー）と、ブラウザー用の\`ticket\`（1回限りの\`wst_…\`）の**どちらか一方**を指定します。[UIへのリアルタイム配信](https://docs.butterbase.ai/ja/core-concepts/substrate/#8-stream-live-updates-to-a-ui)を参照してください。認証情報に紐付く組織に制限します。

<span id="integrations"></span>

## 外部サービスとの連携

Gmail、Slack、GitHubなどのユーザーのアカウントを接続し、そのユーザーとしてツールを実行できます。[外部サービスとの連携](https://docs.butterbase.ai/ja/core-concepts/integrations/)を参照してください。

\`\`\`typescript
// Admin: enable a toolkit for the app (requires API key)
await butterbase.integrations.configure('gmail');

// Browse the catalog
const { data: list } = await butterbase.integrations.listAvailable({ search: 'crm' });

// End-user: generate the OAuth connect URL, then redirect the user
const { data: connect } = await butterbase.integrations.connect('gmail', {
  redirectUrl: 'https://app.example.com/integrations/callback',
});
window.location.href = connect.authUrl;

// End-user: list their connected accounts
const { data: connections } = await butterbase.integrations.listConnections();

// Execute a tool with the calling user's credentials
const { data: result } = await butterbase.integrations.execute('GMAIL_SEND_EMAIL', {
  to: 'user@example.com',
  subject: 'Hi',
  body: 'Hello',
});

// Service-level execution on behalf of a specific user (API key required)
await butterbase.integrations.asUser(userId).execute('GMAIL_SEND_EMAIL', {
  to: 'user@example.com', subject: 'Hi', body: 'Hello'
});
\`\`\`

<span id="admin-client"></span>

## 管理クライアント

\`butterbase.admin\`で、ダッシュボード、MCP、CLIの管理操作を行えます。\`admin.*\`にはAPIキー（\`bb_sk_...\`）が必要です。

| サブクライアント | 管理内容 |
|-----------|---------|
| \`admin.schema\` | スキーマの取得・適用・確認、マイグレーション一覧 |
| \`admin.rls\` | RLSの有効化、ポリシー作成、ユーザー分離 |
| \`admin.oauth\` | Google、GitHubなどのOAuth設定 |
| \`admin.config\` | CORS、JWTのTTL、ストレージの公開読み取り |
| \`admin.functions\` | 関数のデプロイ、一覧、詳細、ログ、環境変数、削除 |
| \`admin.frontend\` | フロントエンドのデプロイとビルド環境変数 |
| \`admin.realtime\` | テーブルのリアルタイム設定 |
| \`admin.domains\` | カスタムドメインの管理 |
| \`admin.apiKeys\` | キーの発行・一覧・失効 |
| \`admin.auditLogs\` | 認証・監査イベントの検索 |

<span id="custom-domains"></span>

### カスタムドメイン

\`\`\`typescript
// Add a domain — response includes the CNAME target you have to set up
const { data: result } = await butterbase.admin.domains.add('app.example.com');
// result.cname_target → set as a CNAME at your DNS provider (DNS-only if Cloudflare)

// Poll status until ssl_status === 'active'
const { data: status } = await butterbase.admin.domains.getStatus(result.domain.id);

// Re-trigger verification after fixing DNS
await butterbase.admin.domains.verify(result.domain.id);

// Remove
await butterbase.admin.domains.remove(result.domain.id);
\`\`\`

<span id="app-config"></span>

### アプリの設定

\`\`\`typescript
const { data: cfg } = await butterbase.admin.config.get();

await butterbase.admin.config.updateCors({
  allowed_origins: ['https://app.example.com'],
});

await butterbase.admin.config.updateJwt({ token_ttl: 3600 });

// Make all storage objects publicly readable across the app
await butterbase.admin.config.updateStorage({ publicReadEnabled: true });
\`\`\`

### RLS

\`\`\`typescript
await butterbase.admin.rls.enable('posts');

await butterbase.admin.rls.createUserIsolation('posts', 'author_id');

await butterbase.admin.rls.createPolicy({
  table_name: 'posts',
  policy_name: 'public_read_published',
  command: 'SELECT',
  role: 'anon',
  using_expression: 'is_published = true',
});
\`\`\`

<span id="typescript-support"></span>

## TypeScriptへの対応

すべてのメソッドは型推論付きの\`ButterbaseResponse<T>\`を返します。

\`\`\`typescript
interface Post {
  id: string;
  title: string;
  content: string;
  status: 'draft' | 'published';
}

const { data, error } = await butterbase
  .from<Post>('posts')
  .select('*')
  .eq('status', 'published');
// data is typed as Post[] | null
\`\`\`

<span id="deno-usage"></span>

## Denoでの利用

\`\`\`typescript
import { createClient } from 'npm:@butterbase/sdk';

const butterbase = createClient({
  appId: Deno.env.get('BUTTERBASE_APP_ID')!,
  apiUrl: Deno.env.get('BUTTERBASE_API_URL')!,
});
\`\`\`

<span id="kv-ctxkv"></span>

## KV（ctx.kv）

関数やクライアントから利用できます。すべてのメソッドは非同期です。

| メソッド | シグネチャ | 説明 |
|--------|-----------|-------------|
| \`get\` | \`get<T>(key: string, opts?: { touch?: boolean }): Promise<T \\| null>\` | キーの値を取得。なければnull。 |
| \`set\` | \`set(key: string, value: unknown, opts?: { ttl?: number \\| null; ephemeral?: boolean }): Promise<void>\` | 値を保存。任意の秒単位TTL。 |
| \`del\` | \`del(key: string): Promise<number>\` | 削除し、削除件数を返す |
| \`incr\` | \`incr(key: string, by?: number): Promise<number>\` | 数値を加算（既定1） |
| \`decr\` | \`decr(key: string, by?: number): Promise<number>\` | 数値を減算（既定1） |
| \`setnx\` | \`setnx(key: string, value: unknown, opts?: { ttl?: number \\| null; ephemeral?: boolean }): Promise<boolean>\` | 存在しない場合だけ保存。成功ならtrue。 |
| \`setex\` | \`setex(key: string, value: unknown, ttl: number, opts?: { ephemeral?: boolean }): Promise<void>\` | TTLを指定して保存（set＋ttlの短縮形） |
| \`cas\` | \`cas(key: string, expected: unknown, next: unknown): Promise<boolean>\` | 現在値がexpectedと一致する場合だけnextへ不可分に置換 |
| \`exists\` | \`exists(key: string): Promise<boolean>\` | キーの存在を確認 |
| \`ttl\` | \`ttl(key: string): Promise<number \\| null>\` | 残りのTTLを秒で取得。nullは無期限、undefinedはキーなし。 |
| \`expire\` | \`expire(key: string, ttl: number \\| null): Promise<boolean>\` | 既存キーのTTLを設定・解除 |
| \`mget\` | \`mget<T>(keys: string[]): Promise<(T \\| null)[]>\` | 複数の値を配列で取得。ないキーはnull。 |
| \`mset\` | \`mset(entries: Record<string, unknown>, opts?: { ttl?: number \\| null }): Promise<void>\` | 複数のキーと値を保存し、すべてにTTLを適用 |
| \`expose\` | \`expose(pattern: string, opts: { read: Role; write: Role }): Promise<void>\` | パターンに対するロールのアクセス権を設定 |
| \`unexpose\` | \`unexpose(pattern: string): Promise<number>\` | 公開ルールを削除し、削除件数を返す |
| \`listRules\` | \`listRules(): Promise<Array<{ pattern: string; read: Role; write: Role; order: number }>>\` | 有効な公開ルールを一覧表示 |

<span id="client-side-example"></span>

### クライアントの例

\`\`\`typescript
const { data } = await butterbase.from('users').select('id').eq('id', userId);
const userId = data?.[0]?.id;

// Increment a counter in KV
const count = await butterbase.kv.incr(\`user_clicks:\${userId}\`);
console.log(\`User has clicked \${count} times\`);

// Set with TTL
await butterbase.kv.set(\`session:\${sessionId}\`, sessionData, { ttl: 3600 });
\`\`\`

<span id="function-example"></span>

### 関数の例

\`\`\`typescript
export async function handler(req: Request, ctx: FunctionContext) {
  const key = 'request_count';
  const count = await ctx.kv.incr(key);

  // Set up role-based access (admin only)
  if (ctx.user?.role === 'admin') {
    await ctx.kv.expose('secret:*', { read: 'owner', write: 'owner' });
  }

  return new Response(JSON.stringify({ count }));
}
\`\`\`

**読み取りでTTLを延長：**

\`\`\`ts
// Each read refreshes the TTL back to the original window
const session = await ctx.kv.get<Session>(\`session:\${id}\`, { touch: true });
\`\`\`

**読み書きの一括処理：**

\`\`\`ts
await ctx.kv.mset({
  'feature:new-checkout': 'on',
  'feature:new-pricing': 'off',
});

const flags = await ctx.kv.mget(['feature:new-checkout', 'feature:new-pricing']);
// flags === ['on', 'off']  (null for any missing key)
\`\`\`

**一時キャッシュへの保存（小さく高速。リージョンの再起動で消える場合があります）：**

\`\`\`ts
await ctx.kv.set(\`cache:user:\${id}\`, payload, { ttl: 60, ephemeral: true });
\`\`\`

<span id="migration-from-0x-to-10"></span>

## 0.xから1.0への移行

\`authUrl\`は廃止しました。認証もAPIと同じURLを使うため、\`apiUrl\`だけを指定してください。`,
  cli: `\`@butterbase/cli\`でアプリ、スキーマ、関数、ストレージ、デプロイを管理できます。

<span id="installation"></span>

## インストール

\`\`\`bash
npm install -g @butterbase/cli
\`\`\`

<span id="quick-start"></span>

## クイックスタート

\`\`\`bash
# Login with your API key
butterbase login

# Create a new app
butterbase apps create my-app

# Set as current app
butterbase apps use app_abc123

# Get current schema
butterbase schema get --output schema.json

# Apply schema changes
butterbase schema apply schema.json

# Deploy a function
butterbase functions deploy ./functions/hello.ts

# Upload a file
butterbase storage upload ./image.png
\`\`\`

<span id="project-init"></span>

## プロジェクトの初期化

\`\`\`bash
# Scaffold a new project (prompts for name, template, optional app ID)
butterbase init

# Specify the template directly
butterbase init react-vite
\`\`\`

対応するテンプレートは\`react-vite\`です。ファイルを作成し、\`.env.example\`があれば\`.env\`へコピーします。\`cd\`、\`npm install\`、\`npm run dev\`と、MCP・エージェントの設定方法を表示します。

<span id="authentication"></span>

## 認証

\`\`\`bash
butterbase login
butterbase logout
\`\`\`

<span id="configuration"></span>

## 設定

\`\`\`bash
# Show current config
butterbase config get

# Set endpoint
butterbase config set endpoint https://api.butterbase.ai

# Set API key
butterbase config set apiKey bb_sk_...
\`\`\`

設定は\`~/.butterbase/config.json\`へ保存します。プロジェクトの\`.butterbase/config.json\`を優先します。

<span id="apps"></span>

## アプリ

\`\`\`bash
butterbase apps list
butterbase apps create my-app
butterbase apps use app_abc123
butterbase apps delete app_abc123
\`\`\`

作成時のリージョン指定と移動には、[MCP](https://docs.butterbase.ai/ja/getting-started/mcp-setup/)（\`init_app\`、\`list_regions\`、\`manage_app\`の\`move\`・\`move_status\`）や[REST API](https://docs.butterbase.ai/ja/api-reference/platform-api/#apps--regions)を使えます。[リージョン](https://docs.butterbase.ai/ja/core-concepts/regions/)を参照してください。

<span id="schema"></span>

## スキーマ

\`\`\`bash
# Get current schema
butterbase schema get

# Save to file
butterbase schema get --output schema.json

# Preview changes (dry-run)
butterbase schema apply schema.json --dry-run

# Apply changes
butterbase schema apply schema.json

# Apply with custom migration name
butterbase schema apply schema.json --name "add_users_table"

# Use specific app
butterbase schema get --app app_abc123
\`\`\`

<span id="functions"></span>

## 関数

\`\`\`bash
# List deployed functions (also prints trigger types and 🤖 marker if exposed as agent tool)
butterbase functions list

# Deploy function
butterbase functions deploy ./functions/hello.ts

# Deploy with custom name
butterbase functions deploy ./functions/hello.ts --name my-function

# Deploy cron function
butterbase functions deploy ./functions/cleanup.ts \\
  --trigger cron \\
  --trigger-config '{"schedule":"*/5 * * * *"}'

# Expose a function to agents as a tool
butterbase functions deploy ./functions/lookup_account.ts \\
  --agent-tool \\
  --agent-tool-description "Look up a customer by email." \\
  --agent-tool-mode read_only \\
  --agent-tool-exposed-to developer_only

# View logs
butterbase functions logs my-function

# Error logs only
butterbase functions logs my-function --level error

# Limit log count
butterbase functions logs my-function --limit 50
\`\`\`

ログは日時、メソッド、ステータス、所要時間、エラーを表示します。\`console.log/info/warn/error/debug\`の出力は各ログの下に字下げして表示します。

**トリガー：** \`http\`（既定）、\`cron\`、\`s3_upload\`、\`webhook\`、\`websocket\`。複数トリガーはダッシュボードまたはRESTの\`triggers: [...]\`で指定します。CLIの\`--trigger\`は単一の指定です。

**ツールの設定：** \`--agent-tool-mode\`は\`read_only\`（既定、承認不要）または\`read_write\`（毎回人の承認を待つ）。\`--agent-tool-exposed-to\`は\`developer_only\`（既定）または\`end_user\`です。

<span id="agents"></span>

## エージェント

\`\`\`bash
# List agents
butterbase agents list

# Show one agent
butterbase agents get my-agent

# Create an agent from a graph_spec.json file
butterbase agents create \\
  --name my-agent \\
  --display-name "My agent" \\
  --default-model anthropic/claude-3.5-sonnet \\
  --spec ./agent-spec.json

# Update fields (status, default_model, graph_spec)
butterbase agents update my-agent --status disabled
butterbase agents update my-agent --spec ./agent-spec.json

# Delete an agent
butterbase agents delete my-agent
\`\`\`

グラフ仕様は[エージェント](https://docs.butterbase.ai/ja/core-concepts/agents/)、一連の手順は[エージェントのクイックスタート](https://docs.butterbase.ai/ja/getting-started/agents-quickstart/)を参照してください。

<span id="storage"></span>

## ストレージ

\`\`\`bash
butterbase storage list
butterbase storage upload ./image.png
butterbase storage delete obj_abc123
\`\`\`

<span id="realtime"></span>

## リアルタイム

\`\`\`bash
# Enable realtime broadcasts on one or more tables
butterbase realtime enable posts comments

# Show realtime configuration (URL, active connection, table list)
butterbase realtime config
butterbase realtime config --json

# Disable realtime on a single table
butterbase realtime disable posts
\`\`\`

<span id="frontend-env-vars"></span>

## フロントエンドの環境変数

これらはフロントエンドのビルドへ埋め込む値です。関数用は上の関数の節と[関数の概念](https://docs.butterbase.ai/ja/core-concepts/functions/)を参照してください。

\`\`\`bash
# Set one or more KEY=VALUE pairs
butterbase env set VITE_API_URL=https://api.example.com DEBUG=true

# List current keys (values are not shown)
butterbase env list
butterbase env list --json

# Load from a .env file
butterbase env set-file .env.production
\`\`\`

<span id="api-keys"></span>

## APIキー

\`\`\`bash
# Generate a new key (shown once)
butterbase keys generate "deploy-bot"

# List keys (key prefix only — full values are not retrievable)
butterbase keys list

# Revoke a key (prompts for confirmation)
butterbase keys revoke key_abc123
\`\`\`

<span id="integrations"></span>

## 外部サービスとの連携

Gmail、Slack、GitHubなどを管理します。[外部サービスとの連携](https://docs.butterbase.ai/ja/core-concepts/integrations/)を参照してください。

\`\`\`bash
# List the curated catalog (or search the full catalog)
butterbase integrations list
butterbase integrations list --search salesforce

# Show toolkits configured for the current app
butterbase integrations config

# Enable a toolkit for the app
butterbase integrations configure gmail
butterbase integrations configure slack --display-name "Workspace bot"

# Disable a toolkit
butterbase integrations disable slack

# Generate an OAuth URL for an end-user to connect their account
butterbase integrations connect gmail \\
  --redirect-url https://app.example.com/integrations/callback

# List all end-user connections
butterbase integrations connections

# Disconnect a single user's account
butterbase integrations disconnect ca_xxx

# List tools available for a connected toolkit
butterbase integrations tools gmail

# Execute a tool (e.g., as a smoke test)
butterbase integrations execute GMAIL_SEND_EMAIL \\
  --data '{"to":"user@example.com","subject":"hi","body":"hello"}'
\`\`\`

多くのサブコマンドでは\`--app <app-id>\`で対象を指定でき、ユーザーの代理実行時は\`--user-id <uuid>\`を使います。

<span id="custom-domains"></span>

## カスタムドメイン

フロントエンドの独自ドメインを管理します。Launch以上が必要です。[カスタムドメイン](https://docs.butterbase.ai/ja/core-concepts/custom-domains/)を参照してください。

\`\`\`bash
# List domains for the current app
butterbase domains list

# Add a new custom hostname (returns the CNAME target + setup instructions)
butterbase domains add app.example.com

# Poll verification status
butterbase domains status dom_abc123

# Re-trigger verification after fixing DNS
butterbase domains verify dom_abc123

# Remove a domain (prompts; pass --yes to skip)
butterbase domains delete dom_abc123 --yes
\`\`\`

<span id="plugin"></span>

## プラグイン

\`\`\`bash
# Set up Claude Code / MCP integration for this project
butterbase plugin setup
\`\`\`

現在のディレクトリへMCP接続用の\`.mcp.json\`を作成します。既存ファイルがある場合は上書きしません。

ガイド付きのButterbase Skillsは別途インストールします。

\`\`\`bash
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills
claude plugin install butterbase-skills@butterbase-skills
\`\`\`

<span id="data"></span>

## データ

\`\`\`bash
butterbase data list             # List tables
butterbase data query posts      # Query rows from a table
\`\`\`

<span id="deployments"></span>

## デプロイ

\`\`\`bash
butterbase deploy ./dist         # Deploy frontend from a directory
\`\`\`

<span id="project-status"></span>

## プロジェクトの状態

\`\`\`bash
# Print app summary: name, region, tables, deployments, env keys, functions, CORS
butterbase status
butterbase status --json
\`\`\`

<span id="open-in-browser"></span>

## ブラウザーで開く

\`\`\`bash
# Open the live frontend URL
butterbase open

# Open the API base URL instead
butterbase open --api
\`\`\`

有効なデプロイがなければ、\`butterbase open\`はエラーで終了します。

<span id="global-options"></span>

## グローバルオプション

多くのコマンドは\`--app\`で対象を指定できます。

\`\`\`bash
butterbase schema get --app app_abc123
butterbase functions list --app app_abc123
butterbase storage list --app app_abc123
\`\`\`

省略すると、\`butterbase apps use\`で選択したアプリを使います。

## KV

\`\`\`bash
# Get a value
butterbase kv get mykey

# Set a value with optional TTL
butterbase kv set mykey '{"a":1}' --ttl 3600

# Delete a key
butterbase kv del mykey

# List keys by prefix
butterbase kv ls --prefix user: --limit 50

# Show KV store statistics
butterbase kv stats

# Flush all keys (requires confirmation)
butterbase kv flush --confirm

# List all exposure rules
butterbase kv rules

# Expose a key pattern with role-based access
butterbase kv expose "user:*" --read authed --write owner

# Unexpose a key pattern
butterbase kv unexpose "user:*"

# Apply exposure rules from a config file
butterbase kv apply ./kv.config.ts --dry-run
\`\`\`

<span id="common-kv-workflows"></span>

### KVのよくある操作

**設定ファイルから公開ルールを反映：**

\`\`\`bash
# kv.config.ts in your project root, then:
butterbase kv apply kv.config.ts
\`\`\`

フロントエンドからアクセスできるキーパターンを宣言します。現在のルールとの差分だけを適用するため、繰り返し実行できます。

**本番のキーを確認：**

\`\`\`bash
butterbase kv ls --prefix session:
# 142 keys under session:*

butterbase kv stats
# {
#   "keys_total": 1284,
#   "bytes_used": 2202112,
#   "max_keys": 100000,
#   "max_storage_bytes": 104857600,
#   "max_ops_per_sec": 500,
#   "max_value_bytes": 65536
# }
\`\`\`

**調査時に1件のキーを読み書き：**

\`\`\`bash
butterbase kv get rate-limit:user_42        # peek a counter
butterbase kv set feature:new-checkout off  # flip a flag without redeploying
\`\`\`

<span id="environment-variables"></span>

## 環境変数

CLIはAPIキーとエンドポイントを設定ファイルから読み取ります。\`butterbase config set\` で設定してください。

\`BUTTERBASE_API_KEY\` は、\`butterbase plugin setup\` と \`butterbase mcp install\` が生成するMCPクライアント設定で使います。\`butterbase integrations configure\` と \`rotate\` は、連携先の \`<TOOLKIT>_CLIENT_ID\` と \`<TOOLKIT>_CLIENT_SECRET\` を環境変数から読み取ることもできます。`,
  realtime: `WebSocket接続でデータ変更をリアルタイム通知します。テーブルで有効にすると、INSERT、UPDATE、DELETEを接続中のクライアントへ配信します。

<span id="enabling-realtime"></span>

## 有効にする

\`\`\`
manage_realtime({ app_id: "app_abc123", action: "configure", tables: ["messages", "notifications"] })
\`\`\`

変更を捕捉してpg_notifyで配信するデータベーストリガーを作成します。

<span id="connecting-via-websocket"></span>

## WebSocket接続

接続先：\`wss://api.butterbase.ai/v1/{app_id}/realtime\`

<span id="authentication"></span>

### 認証

**ブラウザ（推奨）：** クエリパラメーターにトークンを渡します。

\`\`\`
wss://api.butterbase.ai/v1/app_abc123/realtime?token=eyJhbG...
\`\`\`

**Node.js・サーバー側：** Authorizationヘッダーを使います。

\`\`\`javascript
const ws = new WebSocket('wss://api.butterbase.ai/v1/app_abc123/realtime', {
  headers: { Authorization: 'Bearer <jwt>' }
});
\`\`\`

| 認証方法 | 割り当てるロール |
|-------------|--------------|
| エンドユーザーJWT | butterbase_user（RLSを適用） |
| APIキー（\`bb_sk_...\`） | butterbase_service（全変更を取得） |
| 認証なし | butterbase_anon |

<span id="client-protocol"></span>

## クライアントのプロトコル

\`\`\`json
// Client -> Server
{ "type": "subscribe", "table": "messages" }
{ "type": "unsubscribe", "table": "messages" }

// Server -> Client
{ "type": "connected", "app_id": "app_abc123", "role": "butterbase_user" }
{ "type": "subscribed", "table": "messages" }
{ "type": "change", "table": "messages", "op": "INSERT", "record": {...}, "old_record": null, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "UPDATE", "record": {...}, "old_record": {...}, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "DELETE", "record": null, "old_record": {...}, "timestamp": "..." }
{ "type": "heartbeat", "timestamp": "..." }
{ "type": "error", "message": "..." }
\`\`\`

<span id="browser-example"></span>

## ブラウザの例

\`\`\`javascript
const token = 'eyJhbG...'; // end-user JWT
const ws = new WebSocket(\`wss://api.butterbase.ai/v1/app_abc123/realtime?token=\${token}\`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', table: 'messages' }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'change') {
    console.log(msg.op, msg.table, msg.record);
  }
};
\`\`\`

<span id="subscription-filters"></span>

## 購読フィルター

変更の一部だけを購読します。

\`\`\`json
{ "type": "subscribe", "table": "messages", "filter": { "channel_id": "abc" } }
\`\`\`

\`channel_id = 'abc'\`に一致する変更だけを送ります。列の完全一致で判定します。

<span id="row-level-security"></span>

## 行レベルセキュリティ

リアルタイムのイベントにもRLSを適用します。
- **butterbase_user** — SELECT可能な行の変更だけを取得
- **butterbase_service** — 全変更を取得
- **butterbase_anon** — 匿名ユーザーのポリシーで許可された変更を取得

<span id="presence-tracking"></span>

## プレゼンス追跡

ほかの接続ユーザーを追跡します。

\`\`\`json
// Opt in with metadata
{ "type": "presence_track", "metadata": { "name": "Alice", "cursor": { "x": 10, "y": 20 } } }

// Update metadata (e.g. cursor moved)
{ "type": "presence_update", "metadata": { "cursor": { "x": 50, "y": 60 } } }
\`\`\`

サーバーはプレゼンス追跡中の全クライアントへ配信します。

\`\`\`json
{ "type": "presence_state", "clients": [{ "client_id": "...", "user_id": "...", "metadata": {...} }] }
{ "type": "presence_join", "client_id": "...", "user_id": "...", "metadata": {...} }
{ "type": "presence_update", "client_id": "...", "metadata": {...} }
{ "type": "presence_leave", "client_id": "...", "user_id": "..." }
\`\`\`

プレゼンスはメモリ内だけに保存し、サーバー再起動でリセットします。

<span id="websocket-triggers"></span>

## WebSocketトリガー

クライアントの自作イベントで起動する関数をデプロイします。

\`\`\`
deploy_function({
  name: "handle-chat",
  code: "...",
  trigger: { type: "websocket", config: { event: "chat_message" } }
})
\`\`\`

クライアントからイベントを送ります。
\`\`\`json
{ "type": "event", "event": "chat_message", "payload": { "text": "hello" } }
\`\`\`

関数のレスポンスを返します。
\`\`\`json
{ "type": "event_response", "event": "chat_message", "data": { "echo": { "text": "hello" } } }
\`\`\`

<span id="limitations"></span>

## 制限

- リアルタイム有効化の前にテーブルが存在する必要があります
- 各変更で行全体を送ります（列のフィルターは未対応）
- LISTENの再接続中にイベントを失う場合があります。再接続後は状態を再取得してください

<span id="substrate-changes"></span>

## Substrateの変更

このページはアプリの**データベーステーブル**を対象とします。[Substrate](https://docs.butterbase.ai/ja/core-concepts/substrate/)内のエンティティ、アクション台帳、決定・約束・学びには、組織単位で通知の外枠だけを送る別のストリームがあります。[Substrateのライブ更新](https://docs.butterbase.ai/ja/core-concepts/substrate/#8-stream-live-updates-to-a-ui)とSDKの\`bb.substrate.stream\`を参照してください。`,
  rag: `組み込みのRAG（検索拡張生成）で文書を取り込み、意味に基づいて検索できます。チャンク分割、text-embedding-3-smallによる埋め込み、pgvectorへの保存を自動処理し、取り込みと検索の2つのAPIで利用します。

<span id="how-it-works"></span>

## 仕組み

1. **取り込み** — ファイルか生のテキストを解析し、重なりのあるチャンクへ分割してベクトル化。
2. **保存** — アプリのDB内のpgvectorへ保存。HNSWインデックスでコサイン類似度検索を高速化。
3. **検索** — 自然言語の質問をベクトル化し、近いチャンクを類似度順で返す。AI回答の生成も指定可能。

取り込みは非同期で、文書IDをすぐに返します。状態APIでreadyになるまで確認してください。

<span id="collections"></span>

## コレクション

関連文書をまとめる名前空間です（例：support-docs、product-manual）。全文書とチャンクはコレクションに所属し、アプリごとに分かれます。

**名前の規則：** 小文字英数字、ハイフン、アンダースコアだけを使用します（support-docs、product_manualなど）。

<span id="access-modes"></span>

### アクセスモード

| モード | 動作 |
|------|----------|
| \`private\`（既定） | 各ユーザーは自分の文書だけを検索。RLSを自動作成。 |
| \`shared\` | 全認証ユーザーが全コレクション文書を検索可能。 |
| \`custom\` | 自動ポリシーなし。自分でRLSを定義。 |

<span id="creating-a-collection"></span>

### コレクションを作成

\`\`\`json
POST /v1/{app_id}/rag/collections
Authorization: Bearer bb_sk_...

{
  "name": "support-docs",
  "accessMode": "shared",
  "description": "Product support documentation"
}
\`\`\`

レスポンス：

\`\`\`json
{
  "id": "uuid",
  "name": "support-docs",
  "description": "Product support documentation",
  "accessMode": "shared",
  "chunkSize": 512,
  "chunkOverlap": 64,
  "createdAt": "2026-04-23T10:00:00Z"
}
\`\`\`

<span id="ingesting-documents"></span>

## 文書の取り込み

<span id="from-raw-text"></span>

### 生のテキスト

\`\`\`json
POST /v1/{app_id}/rag/collections/support-docs/ingest
Authorization: Bearer bb_sk_...

{
  "text": "Refunds are accepted within 30 days of purchase...",
  "filename": "refund-policy.txt"
}
\`\`\`

<span id="from-a-stored-file"></span>

### 保存済みファイル

1. \`POST /storage/{app_id}/upload\`でアップロードし、objectIdを保存。
2. そのIDを取り込みAPIへ指定：

\`\`\`json
POST /v1/{app_id}/rag/collections/support-docs/ingest
Authorization: Bearer bb_sk_...

{
  "storage_object_id": "uuid-from-upload"
}
\`\`\`

<span id="supported-file-types"></span>

### 対応ファイル

| 種類 | 拡張子 |
|------|------------|
| プレーンテキスト | \`.txt\`、\`.md\` |
| PDF | \`.pdf\` |
| Word | \`.docx\` |
| Excel | \`.xlsx\` |
| PowerPoint | \`.pptx\` |
| HTML | \`.html\` |
| CSV | \`.csv\` |

<span id="async-lifecycle"></span>

### 非同期処理の流れ

\`\`\`
pending → processing → ready
                    ↘ failed
\`\`\`

status: pendingですぐに返します。\`GET /v1/{app_id}/rag/collections/{name}/documents/{id}\`でreadyかfailedになるまで確認します。

<span id="querying"></span>

## 検索

\`\`\`json
POST /v1/{app_id}/rag/collections/support-docs/query
Authorization: Bearer Bearer bb_sk_...

{
  "query": "What is the refund policy?",
  "topK": 5,
  "threshold": 0.7
}
\`\`\`

レスポンス：

\`\`\`json
{
  "chunks": [
    {
      "text": "Refunds are accepted within 30 days of purchase...",
      "score": 0.92,
      "documentId": "uuid",
      "metadata": {}
    }
  ]
}
\`\`\`

<span id="query-parameters"></span>

### 検索パラメーター

| パラメーター | 型 | 既定値 | 説明 |
|-----------|------|---------|-------------|
| \`query\` | string | 必須 | 自然言語の質問 |
| \`topK\` | number | 5 | 返すチャンク数 |
| \`threshold\` | number | — | 最低類似度（0〜1）。未満のチャンクは除外 |
| \`synthesize\` | boolean | false | 取得チャンクからAI回答を生成 |
| \`model\` | string | auto | 回答モデル（例：anthropic/claude-haiku-4-5） |
| \`filter\` | object | — | 結果を絞るメタデータ |

<span id="synthesized-answers"></span>

### 回答の生成

synthesize: trueでチャンクと一緒にAI回答を取得します。

\`\`\`json
{
  "query": "What is the refund policy?",
  "synthesize": true
}
\`\`\`

answerフィールドを返します。

\`\`\`json
{
  "chunks": [...],
  "answer": "Refunds are accepted within 30 days of purchase with a valid receipt.",
  "model": "anthropic/claude-haiku-4-5"
}
\`\`\`

<span id="access-control"></span>

## アクセス制御

通常のテーブルと同じRLSモデルを使います。

- **private** — ユーザー固有の文書・チャンクだけを許可。取り込み時のuser_idをリクエストJWTと照合。
- **shared** — 全認証ユーザーの読み取りを許可。
- **custom** — 自動作成なし。スキーマツールからCREATE POLICYで定義。

<span id="sdk-usage"></span>

## SDKでの利用

\`\`\`typescript
import { createClient } from '@butterbase/sdk';

const butterbase = createClient({
  appId: 'app_abc123',
  apiUrl: 'https://api.butterbase.ai',
});

// Create a shared collection
await butterbase.rag.createCollection({
  name: 'support-docs',
  accessMode: 'shared',
});

// Ingest raw text
const { data: doc } = await butterbase.rag.ingest('support-docs', {
  text: 'Refunds are accepted within 30 days of purchase...',
  filename: 'refund-policy.txt',
});

// Poll until ready
let status = doc.status;
while (status === 'pending' || status === 'processing') {
  await new Promise(r => setTimeout(r, 1000));
  const { data } = await butterbase.rag.getDocument('support-docs', doc.documentId);
  status = data.status;
}

// Query with synthesis
const { data: result } = await butterbase.rag.query('support-docs', {
  query: 'What is the return policy?',
  synthesize: true,
});
console.log(result.answer);
\`\`\`

<span id="ai-credits"></span>

## AIクレジット

- 取り込み・検索の埋め込み費用をAIクレジットから消費。
- synthesize: trueではLLM費用も消費。
- アップロード文書のファイルをストレージ使用量に算入。
- RAG専用の追加料金はなし。

---

RAGのエンドポイントはすべて\`/v1/{app_id}/rag/\`配下です。認証には\`Authorization: Bearer {service_key_or_jwt}\`を指定します。

概要とSDKの使用例は[RAG（標準機能）](https://docs.butterbase.ai/ja/core-concepts/rag/)を参照してください。

<span id="collections"></span>

## コレクション

<span id="create-collection"></span>

### コレクションの作成

\`\`\`
POST /v1/{app_id}/rag/collections
\`\`\`

**リクエスト本文：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| \`name\` | string | はい | 小文字の英数字、ハイフン、アンダースコア |
| \`description\` | string | いいえ | 人が読むための説明 |
| \`accessMode\` | \`private\` \\| \`shared\` \\| \`custom\` | いいえ | 既定値：\`private\` |
| \`chunkSize\` | number | いいえ | チャンクあたりの文字数。既定値：512 |
| \`chunkOverlap\` | number | いいえ | チャンク間で重ねる文字数。既定値：64 |

**応答：** \`Collection\`オブジェクト（201）。

---

<span id="list-collections"></span>

### コレクション一覧の取得

\`\`\`
GET /v1/{app_id}/rag/collections
\`\`\`

**応答：** \`Collection\`オブジェクトの配列。

---

<span id="get-collection"></span>

### コレクションの取得

\`\`\`
GET /v1/{app_id}/rag/collections/{name}
\`\`\`

文書数とチャンク数を含むコレクションの詳細を返します。

**応答：** \`CollectionDetails\`オブジェクト。

---

<span id="delete-collection"></span>

### コレクションの削除

\`\`\`
DELETE /v1/{app_id}/rag/collections/{name}
\`\`\`

コレクションと、その文書・チャンク・埋め込みをすべて完全に削除します。元に戻せません。

**応答：** \`204 No Content\`。

---

<span id="documents"></span>

## 文書

<span id="ingest-document"></span>

### 文書の取り込み

\`\`\`
POST /v1/{app_id}/rag/collections/{name}/ingest
\`\`\`

非同期処理のキューへ文書を追加します。\`status: "pending"\`をすぐに返します。

**リクエスト本文（テキスト）：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| \`text\` | string | はい* | 取り込むテキストの内容 |
| \`filename\` | string | いいえ | 文書の表示名 |
| \`metadata\` | object | いいえ | 各チャンクに保存する任意のキーと値のメタデータ |

**リクエスト本文（ストレージのファイル）：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| \`storage_object_id\` | string | はい* | ストレージのアップロードAPIが返すオブジェクトID |
| \`filename\` | string | いいえ | 表示名を上書き |
| \`metadata\` | object | いいえ | 任意のキーと値のメタデータ |

*\`text\`または\`storage_object_id\`のいずれかが必須です。

**応答：** \`IngestResult\`オブジェクト（202）。

\`\`\`json
{
  "documentId": "uuid",
  "status": "pending",
  "message": "Document queued for processing"
}
\`\`\`

---

<span id="list-documents"></span>

### 文書一覧の取得

\`\`\`
GET /v1/{app_id}/rag/collections/{name}/documents
\`\`\`

**応答：** \`RagDocument\`オブジェクトの配列。

---

<span id="get-document"></span>

### 文書の取得

\`\`\`
GET /v1/{app_id}/rag/collections/{name}/documents/{document_id}
\`\`\`

文書の状態とメタデータを返します。\`status\`が\`ready\`または\`failed\`になるまでポーリングできます。

**応答：** \`RagDocument\`オブジェクト。

---

<span id="delete-document"></span>

### 文書の削除

\`\`\`
DELETE /v1/{app_id}/rag/collections/{name}/documents/{document_id}
\`\`\`

文書と、そのベクトルチャンクをすべて削除します。元に戻せません。

**応答：** \`204 No Content\`。

---

<span id="query"></span>

## クエリ

<span id="semantic-query"></span>

### 意味検索

\`\`\`
POST /v1/{app_id}/rag/collections/{name}/query
\`\`\`

**リクエスト本文：**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| \`query\` | string | はい | 自然言語の質問 |
| \`topK\` | number | いいえ | 取得するチャンクの件数。既定値：5 |
| \`threshold\` | number | いいえ | コサイン類似度の下限（0〜1）。下限未満のチャンクは除外します。 |
| \`synthesize\` | boolean | いいえ | 取得したチャンクからAIの回答を生成します。既定値：false |
| \`model\` | string | いいえ | 回答生成に使うモデル（例：\`anthropic/claude-haiku-4-5\`）。省略すると自動選択します。 |
| \`filter\` | object | いいえ | メタデータのフィルター（キーと値の組）。一致するチャンクだけを返します。 |

**応答：** \`synthesize: false\`の場合は\`QueryResult\`、\`synthesize: true\`の場合は\`SynthesizedQueryResult\`。

---

<span id="response-schemas"></span>

## 応答スキーマ

### Collection

\`\`\`json
{
  "id": "uuid",
  "name": "support-docs",
  "description": "Product support documentation",
  "accessMode": "shared",
  "chunkSize": 512,
  "chunkOverlap": 64,
  "createdAt": "2026-04-23T10:00:00Z",
  "updatedAt": "2026-04-23T10:00:00Z"
}
\`\`\`

### CollectionDetails

\`Collection\`に次のフィールドを追加した形式です。

\`\`\`json
{
  "documentCount": 12,
  "chunkCount": 347
}
\`\`\`

### RagDocument

\`\`\`json
{
  "id": "uuid",
  "collectionId": "uuid",
  "filename": "refund-policy.pdf",
  "status": "ready",
  "chunkCount": 28,
  "metadata": {},
  "errorMessage": null,
  "createdAt": "2026-04-23T10:00:00Z",
  "updatedAt": "2026-04-23T10:01:30Z"
}
\`\`\`

**状態の値：** \`pending\` → \`processing\` → \`ready\`または\`failed\`

### IngestResult

\`\`\`json
{
  "documentId": "uuid",
  "status": "pending",
  "message": "Document queued for processing"
}
\`\`\`

### QueryResult

\`\`\`json
{
  "chunks": [
    {
      "text": "Refunds are accepted within 30 days...",
      "score": 0.92,
      "documentId": "uuid",
      "metadata": {}
    }
  ]
}
\`\`\`

### SynthesizedQueryResult

\`QueryResult\`に次のフィールドを追加した形式です。

\`\`\`json
{
  "chunks": [...],
  "answer": "Refunds are accepted within 30 days of purchase with a valid receipt.",
  "model": "anthropic/claude-haiku-4-5"
}
\`\`\``,
  integrations: `ユーザーがGmail、Slack、GitHubなどのアカウントを接続し、アプリの代理操作を許可できます。OAuth、トークン保存、更新処理はButterbaseが管理します。

<span id="how-it-works"></span>

## 仕組み

1. **設定** — 開発者がツールキットを有効にすると、OAuth設定を作成します。
2. **接続** — ユーザーの接続操作でAPIを呼び、取得したURLへ誘導します。OAuthのやり取りは自動処理します。
3. **実行** — ツール名と引数でAPIを呼び、保存済みユーザー認証情報で外部へ転送します。

<span id="curated-integrations"></span>

## 推奨連携

検証済みで標準対応するツールキットです。

| ツールキット | スラッグ | 用途 |
|---------|------|-----------|
| Gmail | \`gmail\` | メール送信、受信一覧、ラベル管理 |
| Google Calendar | \`google-calendar\` | 予定作成、会議一覧 |
| Slack | \`slack\` | メッセージ、チャンネル、ユーザー管理 |
| Google Sheets | \`google-sheets\` | 表の読み書き |
| Notion | \`notion\` | ページ作成、検索、DB更新 |
| GitHub | \`github\` | Issue、PR、リポジトリ閲覧 |
| HubSpot | \`hubspot\` | 連絡先、商談、企業管理 |
| Outlook | \`outlook\` | メール、カレンダー |
| Google Drive | \`google-drive\` | アップロード、取得、一覧 |
| Discord | \`discord\` | メッセージ、サーバー管理 |

\`GET /v1/:appId/integrations/available?search=<query>\`で1000以上のツールキットを含む全カタログも検索できます。

<span id="configuring-an-integration-admin"></span>

## 管理者が連携を設定

APIキーでアプリのツールキットを有効にします。

\`\`\`json
POST /v1/:appId/integrations/configure
{
  "toolkit": "gmail",
  "displayName": "Gmail",
  "scopes": []
}
\`\`\`

レスポンス：
\`\`\`json
{
  "id": "uuid",
  "app_id": "app_abc123",
  "toolkit_slug": "gmail",
  "enabled": true
}
\`\`\`

無効化：\`DELETE /v1/:appId/integrations/configure/:toolkit\`

<span id="connecting-an-end-user-account"></span>

## ユーザーがアカウントを接続

リダイレクトURLを指定して接続APIを呼び、OAuth認可ページへ送ります。

\`\`\`json
POST /v1/:appId/integrations/connect
Authorization: Bearer <user-jwt>
{
  "toolkit": "gmail",
  "redirectUrl": "https://yourapp.com/settings?tab=integrations"
}
\`\`\`

レスポンス：
\`\`\`json
{
  "authUrl": "https://accounts.google.com/...",
  "connectionRequestId": "ca_xxx"
}
\`\`\`

ユーザーをauthUrlへ誘導します。認可後はredirectUrlへ\`?status=connected&toolkit=gmail\`付きで戻ります。

:::note
OAuthコールバックはButterbaseがすべて処理します。アプリにコールバック経路は不要です。
:::

<span id="executing-tools"></span>

## ツールを実行

接続後はそのツールキットの各ツールを実行できます。

\`\`\`json
POST /v1/:appId/integrations/execute
Authorization: Bearer <user-jwt>
{
  "toolName": "GMAIL_SEND_EMAIL",
  "params": {
    "to": "user@example.com",
    "subject": "Hello from my app",
    "body": "This was sent via Butterbase integrations."
  }
}
\`\`\`

レスポンス：
\`\`\`json
{
  "successful": true,
  "data": { "messageId": "msg_xxx" }
}
\`\`\`

利用可能なツールの一覧取得：

\`\`\`
GET /v1/:appId/integrations/tools?toolkit=gmail
\`\`\`

<span id="using-integrations-in-functions"></span>

## 関数から利用

全Butterbase関数にctx.integrationsを渡します。

\`\`\`typescript
export default async function handler(ctx) {
  // Execute a tool on behalf of the calling user
  const result = await ctx.integrations.execute('GMAIL_SEND_EMAIL', {
    to: ctx.body.email,
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  });

  // Execute as a specific user (e.g. in a cron job)
  const events = await ctx.integrations.asUser(userId).execute(
    'GOOGLECALENDAR_EVENTS_LIST',
    { timeMin: new Date().toISOString() }
  );

  return { ok: true };
}
\`\`\`

**認証：** アプリごとの関数キーを自動設定します。
このキーは対象アプリの/integrations/executeだけを呼べます。
サービスの呼び出し元として動くため、エンドユーザーの接続を使う場合は
.asUser(userId)が必要です（cron、定期同期、Webhookなど）。
ユーザー指定のないctx.integrations.execute(...)は、
エンドユーザーJWTで関数を呼んだ場合だけ利用できます。
リクエストの認証コンテキストから接続先を解決するためです。

## SDK

\`\`\`typescript
import { Butterbase } from '@butterbase/sdk';
const bb = new Butterbase({ appId: 'app_xxx', apiKey: 'bb_sk_...' });

// Admin: configure a toolkit
await bb.integrations.configure('slack');

// Get configured integrations
const { data } = await bb.integrations.getConfig();

// User: generate OAuth connect URL
const { data: result } = await bb.integrations.connect('slack', {
  redirectUrl: 'https://yourapp.com/connected',
});
window.location.href = result.authUrl;

// Execute a tool (JWT auth)
const { data } = await bb.integrations.execute('SLACK_SEND_MESSAGE', {
  channel: '#general',
  text: 'Hello from my app',
});

// Service-level execution on behalf of a user
const { data } = await bb.integrations.asUser(userId).execute(
  'GMAIL_SEND_EMAIL',
  { to: 'user@example.com', subject: 'Hi', body: 'Hello' }
);
\`\`\`

<span id="managing-connections"></span>

## 接続を管理

\`\`\`
GET /v1/:appId/integrations/connections          — list connected accounts
DELETE /v1/:appId/integrations/connections/:id   — disconnect an account
\`\`\`

ユーザーは自分の接続だけを見られます。APIキーではアプリの全接続を見られます。

---

連携エンドポイントは認証が必要です。管理操作（設定、有効化解除、設定一覧）はAPIキー（\`Authorization: Bearer bb_sk_...\`）を使います。ユーザー操作（接続、実行、接続一覧）はユーザーJWT、または本文の\`userId\`とAPIキーを使います。OAuthコールバックは公開経路です。

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 認証 | 説明 |
|--------|------|------|-------------|
| \`GET\` | \`/v1/:appId/integrations/available\` | APIキー | 推奨ツールキット一覧またはカタログ検索 |
| \`GET\` | \`/v1/:appId/integrations/config\` | APIキー | 有効な連携を一覧取得 |
| \`POST\` | \`/v1/:appId/integrations/configure\` | APIキー | ツールキットを有効化 |
| \`DELETE\` | \`/v1/:appId/integrations/configure/:toolkit\` | APIキー | ツールキットを無効化 |
| \`POST\` | \`/v1/:appId/integrations/connect\` | JWTまたはAPIキー＋userId | ユーザー用OAuth URLを生成 |
| \`GET\` | \`/v1/:appId/integrations/callback\` | 公開 | OAuthコールバック |
| \`GET\` | \`/v1/:appId/integrations/connections\` | JWTまたはAPIキー | 接続済みアカウント一覧 |
| \`DELETE\` | \`/v1/:appId/integrations/connections/:id\` | JWTまたはAPIキー | アカウント接続を解除 |
| \`GET\` | \`/v1/:appId/integrations/tools\` | JWTまたはAPIキー | 利用可能なツール一覧 |
| \`POST\` | \`/v1/:appId/integrations/execute\` | JWTまたはAPIキー＋userId | ツールを実行 |

## GET /v1/:appId/integrations/available

推奨ツールキット10種を一覧取得するか、\`?search=\`で全カタログを検索します。

\`\`\`
GET /v1/app_abc/integrations/available?search=salesforce
\`\`\`

レスポンス：
\`\`\`json
{
  "integrations": [
    { "toolkit": "salesforce", "displayName": "Salesforce", "curated": false }
  ]
}
\`\`\`

## POST /v1/:appId/integrations/configure

アプリでツールキットを有効にします。

\`\`\`json
{
  "toolkit": "gmail",
  "displayName": "Gmail",
  "scopes": []
}
\`\`\`

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| \`toolkit\` | string | ✓ | ツールキットのスラッグ（例：\`gmail\`、\`google-calendar\`） |
| \`displayName\` | string | | ダッシュボードに表示する名前 |
| \`scopes\` | string[] | | OAuthスコープ（既定ではプラットフォームが管理） |

## POST /v1/:appId/integrations/connect

ユーザー用のOAuth URLを生成します。ユーザーを\`authUrl\`へ誘導してください。

\`\`\`json
{
  "toolkit": "gmail",
  "redirectUrl": "https://yourapp.com/settings",
  "userId": "uuid"
}
\`\`\`

APIキー認証では\`userId\`が必須です。ユーザーJWTでは省略します。

レスポンス：
\`\`\`json
{
  "authUrl": "https://accounts.google.com/...",
  "connectionRequestId": "ca_xxx"
}
\`\`\`

## POST /v1/:appId/integrations/execute

認証済みユーザーの接続アカウントでツールを実行します。

\`\`\`json
{
  "toolName": "GMAIL_SEND_EMAIL",
  "params": { "to": "x@y.com", "subject": "Hi", "body": "Hello" },
  "userId": "uuid"
}
\`\`\`

APIキー利用時は\`userId\`が必須です。ユーザーJWTでは省略します。

成功時のレスポンス：
\`\`\`json
{ "successful": true, "data": { ... } }
\`\`\`

失敗時のレスポンス（\`422\`はツール側の失敗、\`502\`はネットワークエラー）：
\`\`\`json
{
  "error": {
    "code": "INTEGRATIONS_EXECUTION_FAILED",
    "message": "...",
    "remediation": "Check the tool name and parameters. Ensure the user has a connected account."
  }
}
\`\`\`

<span id="error-codes"></span>

## エラーコード

| コード | HTTP | 意味 |
|------|------|---------|
| \`INTEGRATIONS_NOT_CONFIGURED\` | 400 | プラットフォームに連携サービスが未設定 |
| \`INTEGRATIONS_TOOLKIT_NOT_ENABLED\` | 400 | このアプリで未有効化。先に\`/configure\`を呼ぶ |
| \`INTEGRATIONS_EXECUTION_FAILED\` | 422/502 | ツール実行失敗（422：ツール側の失敗、502：ネットワークエラー） |`,
  substrate: `Substrateは、AIエージェントの永続的な記憶と外部への操作を、ユーザー単位の台帳でまとめて管理する層です。各アプリのエンティティ、決定、提案を同じ場所へ記録し、確認・制御できます。

[関数](https://docs.butterbase.ai/ja/core-concepts/functions/)内の\`ctx.substrate\`、CLIの[\`butterbase substrate\`](https://docs.butterbase.ai/ja/cli/substrate/)、Substrate用キーによるHTTPから利用できます。

<span id="what-you-get"></span>

## 主な機能

| 概念 | 内容 |
|---|---|
| **エンティティ** | 人物、企業、プロジェクト、エージェントなどの永続的な対象。 |
| **アクション台帳** | 提案者、ポリシーの判断、実行結果。 |
| **決定・約束・学び・原則** | 後から検索できる長期の記憶。 |
| **元資料** | 会議、メール、録音、文書などの全文検索可能な資料。決定・約束・学びの根拠を参照できます。 |
| **注意ルール** | スナップショットを定期評価し、条件に一致すると提案するルール。 |
| **Outboxの送信先** | 実行時のHMAC署名付きWebhook。 |
| **設定** | \`yolo_mode\`の自動承認など、ユーザー単位の設定。 |
| **WebSocketストリーム** | エンティティ、台帳、記憶、ルール、発火の変更をリアルタイム配信。 |

<span id="how-agents-use-it"></span>

## エージェントからの利用

Substrateのユーザーに紐付けたアプリの関数では、\`ctx\`に\`substrate\`を追加します。

\`\`\`typescript
export async function handler(req, ctx) {
  // Propose an action. The substrate's policy engine decides whether it
  // executes immediately, queues for approval, or is rejected.
  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Migrate billing to Stripe',
    kind: 'strategic',
    rationale: 'Vendor consolidation; lower switching cost than custom.',
  });

  // Search prior memory.
  const prior = await ctx.substrate.searchMemory('billing', { kinds: ['decisions'], limit: 5 });

  // Look up an entity.
  const people = await ctx.substrate.findEntities({ type: 'person', limit: 10 });

  return Response.json({ verdict, prior, people });
}
\`\`\`

使える呼び出し：

| 呼び出し | 用途 |
|---|---|
| \`propose(capability, payload, opts?)\` | 提案。応答：\`{ action_id, verdict, requires_approval, result? }\`。 |
| \`getEntity(entity_id)\` | エンティティを1件取得 |
| \`findEntities({ type?, q?, limit? })\` | 一覧・検索 |
| \`searchMemory(query, { kinds?, limit? })\` | 決定、約束、学び、元資料の全文検索 |

<span id="capabilities-at-a-glance"></span>

### 機能の一覧

提案は即座に実行するか、\`proposed\`で所有者の承認を待ちます。表の既定ポリシーが初期の動作です。所有者は1回の呼び出しに\`dangerously_skip_approval: true\`を指定できますが、エージェントは指定できません。

**\`record_decision\`は自動承認ですが、\`record_principle\`、\`supersede_decision\`、\`retire_principle\`は既定で人の承認が必要です。** ポリシーの判断に影響する情報を変更するためです。

| 機能 | 既定ポリシー | 取り消し可能 | 制限あり | 補足 |
|---|---|---|---|---|
| \`record_decision\` | auto | はい | いいえ | 決定を記録 |
| \`record_commitment\` | auto | はい | いいえ | 約束を記録。任意の\`source_artifact_id\`。 |
| \`record_learning\` | auto | はい | いいえ | 振り返りの学びを記録 |
| \`upsert_entity\` | auto | はい | いいえ | 作成・更新。id、canonical_keys、primary_emailの順で重複を確認。 |
| \`update_entity\` | auto | はい | いいえ | 旧形式。\`attrs\`全体を置換。\`patch_entity\`を優先してください。 |
| \`patch_entity\` | auto | はい | いいえ | RFC 7396による\`attrs\`の部分更新。\`if_updated_at\`の楽観ロックに対応。 |
| \`upsert_source_artifact\` | auto | はい | いいえ | 元資料の作成・更新。\`(external_system, external_id)\`で冪等。 |
| \`revert_action\` | auto | いいえ | いいえ | 取り消し可能なアクションを1件取り消す |
| \`record_principle\` | approval_required | いいえ | いいえ | ポリシーで使う原則を記録。人の承認が必要。 |
| \`supersede_decision\` | approval_required | いいえ | いいえ | 以前の決定を置き換える。人の承認が必要。 |
| \`retire_principle\` | approval_required | いいえ | いいえ | 原則を\`status=expired\`にする。人の承認が必要。 |
| \`delete_entity\` | approval_required | いいえ | いいえ | 完全削除。取り消せません。 |
| \`merge_entities\` | approval_required | いいえ | いいえ | 別名を残して重複を統合。取り消せません。 |
| \`bulk_revert_actions\` | approval_required | いいえ | いいえ | 最大200件を一括取り消し。個別の失敗は応答に含めます。 |
| \`send_email_draft\` | approval_required | いいえ | いいえ | メールの下書きを操作として記録。エージェントの提案には常に承認が必要。 |

アプリの関数からの提案は\`kind: 'agent'\`です。[yoloモード](https://docs.butterbase.ai/ja/core-concepts/substrate/#yolo-mode)が有効でも、外部への操作の一部には人の承認が必要です。

<span id="entity-primitives"></span>

## エンティティの基本操作

<span id="upsert-upsert_entity"></span>

### 作成または更新（\`upsert_entity\`）

重複を探す順序：**\`id\` > \`canonical_keys\` > \`primary_email\` > 新規作成**。

- \`id\`があればIDで作成・更新します（従来の動作）。
- 空でない\`canonical_keys\`があれば、同じ種類で指定したすべてのキーと値を含む行を探します（JSONBの\`@>\`）。一致すれば更新し、\`was_insert: false\`を返します。
- \`primary_email\`があれば\`(type, lower(primary_email))\`で探します。一致すれば更新し、新規作成なら\`canonical_keys.email\`へ自動で反映して両方の方法で重複を探せるようにします。

メールは部分一意インデックスで競合を防ぎます。\`canonical_keys\`だけでは同時書き込みが競合する場合があるため、\`merge_entities\`で整理してください。

<span id="patch-patch_entity"></span>

### 部分更新（\`patch_entity\`）

\`attrs\`へRFC 7396のJSON Merge Patchを不可分な操作で適用します。

\`\`\`ts
await ctx.substrate.patchEntity('ent_…', { title: 'CTO', previous_title: null });
// title set to 'CTO', previous_title key deleted, all other attrs untouched.
\`\`\`

\`if_updated_at\`を指定すると、競合時に上書きせずエラーを返す楽観ロックを使えます。

部分更新には\`patch_entity\`を使ってください。旧\`update_entity\`は\`attrs\`全体を置き換える互換用の操作です。

<span id="merge-merge_entities"></span>

### 統合（\`merge_entities\`）

重複したエンティティを残す側へ統合します。

\`\`\`ts
await ctx.substrate.mergeEntities('ent_loser', 'ent_winner', 'duplicate by email');
\`\`\`

動作：
- **削除する側**を\`substrate.entities\`から完全に削除します。
- \`substrate.entity_aliases\`へ\`loser_id → winner_id\`の別名を登録します。
- **外部キーは自動で書き換えません。** 他のエンティティの\`attrs.company_id = 'ent_loser'\`などは維持されるため、読み取り時に\`entity_aliases\`で古いIDを解決してください。

  \`\`\`sql
  SELECT COALESCE(a.canonical_id, $1) AS resolved_id
  FROM (VALUES ($1)) t(id)
  LEFT JOIN substrate.entity_aliases a ON a.alias_id = $1;
  \`\`\`

- 統合ごとに1つの台帳アクションを作ります。\`reversible: false\`で、自動では元に戻せません。

<span id="delete-delete_entity"></span>

### 削除（\`delete_entity\`）

完全削除で、取り消せません。既定で承認が必要です。

\`\`\`ts
await ctx.substrate.deleteEntity('ent_…', 'manual cleanup');
\`\`\`

重複の整理には、別名を維持する\`merge_entities\`を優先してください。不要で参照を残す必要がない場合だけ\`delete_entity\`を使います。

論理削除には\`ctx.substrate.patchEntity(id, { deleted_at: new Date().toISOString() })\`を使い、読み取りで除外します。

<span id="idempotent-proposals"></span>

### 提案の重複排除

\`propose\`の第3引数、または\`POST /v1/me/substrate/actions/propose\`の本文に\`idempotency_key\`を指定すると、通信障害、Lambdaの再実行、Webhookの再送でも二重登録しません。

\`\`\`ts
await ctx.substrate.propose('record_decision', payload, {
  idempotency_key: 'mtg_2026-06-16:record_decision',
});
\`\`\`

キーはユーザーごとで、TTLなしで保持します。処理単位で固定の値（会議IDと機能の組み合わせなど）を使い、呼び出しごとのUUIDは避けてください。同じキーなら以前のアクションと現在の状態を返し、\`"replay": true\`を含めます。

<span id="bulk-revert-bulk_revert_actions"></span>

### 一括取り消し（\`bulk_revert_actions\`）

最大200件を1回で取り消します。一部の失敗は例外ではなく応答に含めます。誤った取り込みが多数のアクションを生成した場合などに使います。

\`\`\`ts
await ctx.substrate.propose('bulk_revert_actions', {
  action_ids: ['act_…', 'act_…', /* … */],
  reason: 'rolling back failed ingest run 2026-06-11',
});
\`\`\`

<span id="authentication"></span>

## 認証

接続方法は3つあります。

1. **Substrate用APIキー**（\`bb_sub_*\`）：CLI、SDK、自動処理用。\`butterbase keys generate --substrate\`で発行します。
2. **Cognitoセッション**：Webのダッシュボードで自動的に扱います。
3. **デプロイ済みの関数内**：紐付けたアプリの\`ctx.substrate\`を自動で設定し、トークンの管理は不要です。

<span id="yolo-mode"></span>

## yoloモード

通常はポリシーを評価し、必要なら承認を待ちます。\`yolo_mode\`で、人からの提案を自動承認できます。

\`\`\`bash
butterbase substrate settings yolo on
\`\`\`

\`ctx.substrate\`のエージェントによる外部への操作には、yoloモードの自動承認は適用しません。

<span id="the-dashboard"></span>

## ダッシュボード

\`/substrate\`で台帳、エンティティ、メモリー、注意ルール、承認待ちを確認できます。CLIの操作はブラウザーからも行えます。

<span id="walkthrough--your-first-substrate-aware-agent"></span>

## 手順：Substrateを使う最初のエージェント

決定を提案する関数、定期的に条件を確認する注意ルール、実行時のWebhookを作ります。所要時間の目安は10分です。

<span id="1-provision-your-substrate"></span>

### 1. Substrateの準備

初回利用時に作成します。ダッシュボードのOpen Substrate、またはCLIで開始します。

\`\`\`bash
butterbase substrate settings show
\`\`\`

\`{"yolo_mode": false, ...}\`なら準備済みです。\`not provisioned\`なら、表示される解決方法に従ってください。

<span id="2-generate-a-substrate-scoped-key"></span>

### 2. Substrate用キーの発行

\`\`\`bash
butterbase keys generate --substrate --name "my-laptop"
# → bb_sub_…  (shown once — store it now)
export BUTTERBASE_API_KEY="bb_sub_..."
\`\`\`

自分のSubstrateに紐付きます。アプリのデータベースを読み書きする権限はありません。

<span id="3-propose-your-first-action-from-the-cli"></span>

### 3. CLIで最初の提案

\`\`\`bash
butterbase substrate propose record_decision \\
  --payload '{"title":"Adopt substrate","kind":"strategic","rationale":"agent memory needs a single source of truth"}'
\`\`\`

応答：

\`\`\`json
{
  "action_id": "act_01...",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01..." }
}
\`\`\`

\`substrate.decisions\`へ保存したことを確認します。

\`\`\`bash
butterbase substrate memory "adopt substrate" --kinds decisions
\`\`\`

<span id="4-link-an-app-to-substrate"></span>

### 4. アプリとの紐付け

明示的に紐付けたアプリの関数だけに\`ctx.substrate\`を設定します。ダッシュボードのLink to substrate、またはSDK・CLIで設定してください。

<span id="5-deploy-a-function-that-uses-ctxsubstrate"></span>

### 5. \`ctx.substrate\`を使う関数のデプロイ

\`\`\`typescript
// fn-summarize-week.ts
export async function handler(req, ctx) {
  const lastWeekDecisions = await ctx.substrate.searchMemory('', { kinds: ['decisions'], limit: 20 });

  const verdict = await ctx.substrate.propose('record_decision', {
    title: 'Weekly summary',
    kind: 'operational',
    rationale: \`Reviewed \${lastWeekDecisions.length} decisions this week.\`,
  });

  return Response.json({ verdict, count: lastWeekDecisions.length });
}
\`\`\`

\`butterbase fn deploy\`またはMCPの\`deploy_function\`でデプロイします。1回実行すると、台帳に\`kind: 'agent'\`とアプリの\`source_app_id\`を記録します。

<span id="6-add-an-attention-rule"></span>

### 6. 注意ルールの追加

日次スナップショットへ[JSON-Logic](https://jsonlogic.com/)を適用し、一致するとテンプレートから提案します。

\`\`\`json
{
  "name": "weekly digest",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [ { "var": "entity_count" }, 0 ] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities tracked this week."
  }
}
\`\`\`

保存して作成します。

\`\`\`bash
butterbase substrate rules create --file rule.json
\`\`\`

定期実行せずに、今日の結果をプレビューできます。

\`\`\`bash
butterbase substrate rules preview --file rule.json
\`\`\`

<span id="7-send-execution-events-to-a-webhook"></span>

### 7. Webhookへの実行イベントの送信

\`send_email_draft\`などの機能が承認され実行されると、自分のエンドポイントへPOSTできます。

\`\`\`bash
butterbase substrate outbox put send_email_draft \\
  --webhook-url https://example.com/hooks/substrate \\
  --signing-secret "$(openssl rand -hex 16)"
\`\`\`

指定したシークレットで\`X-Butterbase-Signature: sha256=…\`を付けます。再試行と失敗後の待機列を自動で処理します。

<span id="8-stream-live-updates-to-a-ui"></span>

### 8. UIへのリアルタイム配信

書き込みの変更をWebSocketで配信します。フレームは本文を含まない\`{ org, op, tbl, id }\`です。IDで行を再取得してください。[リアルタイム](https://docs.butterbase.ai/ja/core-concepts/realtime/)と同じ方式です。

対象は\`entities\`、\`action_ledger\`、\`decisions\`、\`commitments\`、\`learnings\`、\`attention_rules\`、\`attention_rule_firings\`です。組織単位で、認証情報に紐付いた組織の変更だけを受信します。

クライアントの認証情報に応じて3つの方法があります。

**a）Substrateキーを持つサーバー・スクリプト。** SDKの\`bb.substrate.stream\`がWebSocket、間隔を延ばした再接続、helloフレームの除外を処理します。

\`\`\`typescript
import { createClient } from '@butterbase/sdk';
const bb = createClient({ apiUrl: 'https://api.butterbase.ai', /* … */ });

const sub = bb.substrate.stream({
  token: process.env.BUTTERBASE_SUBSTRATE_KEY, // bb_sub_… or bb_sk_…
  onChange: (evt) => {
    // evt = { org, op: 'insert' | 'update' | 'delete', tbl, id }
    if (evt.tbl === 'entities') refetchEntity(evt.id);
  },
  onStatus: (s) => console.log('substrate stream', s), // 'connecting' | 'open' | 'closed'
});

// later
sub.unsubscribe();
\`\`\`

**b）Substrateキーを持たないエンドユーザーのブラウザー。** キーをブラウザーへ渡さず、アプリの関数で**1回限りのチケット**を発行してください。関数内：

\`\`\`typescript
// app function: substrate-proxy
export async function handler(req, ctx) {
  const { op } = await req.json();
  if (op === 'ws_ticket') {
    return Response.json(await ctx.substrate.wsTicket()); // { ticket, expires_in }
  }
  // … other ops
}
\`\`\`

ブラウザー内：

\`\`\`typescript
// 1. Ask your function for a 60s single-use ticket.
const { ticket } = await bb.functions.invoke('substrate-proxy', { op: 'ws_ticket' });

// 2. Open the stream, then re-fetch on each change.
const ws = new WebSocket(\`wss://api.butterbase.ai/v1/me/substrate/stream?ticket=\${ticket}\`);
ws.onmessage = (evt) => {
  const change = JSON.parse(evt.data);
  if (change.type === 'hello') return;
  // change = { org, op, tbl, id } — e.g. invalidate your query cache by id
};
\`\`\`

**c）Cognitoセッションのあるダッシュボード。** 関数を経由せず、直接チケットを発行できます。

\`\`\`typescript
const { ticket } = await fetch('/v1/me/substrate/ws-ticket', {
  method: 'POST',
  credentials: 'include',
}).then(r => r.json());
const ws = new WebSocket(\`wss://api.butterbase.ai/v1/me/substrate/stream?ticket=\${ticket}\`);
\`\`\`

接続時に\`{ type: 'hello' }\`、その後は変更ごとのフレームを送ります。**チケットは1回限りで60秒で失効**します。再接続のたびに発行し、再試行の間隔を延ばしてください。SDKの\`bb.substrate.stream\`では自動で行います。

<span id="see-also"></span>

## 関連ページ

- [CLI：\`butterbase substrate\`](https://docs.butterbase.ai/ja/cli/substrate/)：シェルからの管理コマンド。
- [Substrate API](https://docs.butterbase.ai/ja/api-reference/substrate-api/)：HTTPのパスと本文・応答。
- [関数](https://docs.butterbase.ai/ja/core-concepts/functions/)：\`ctx.substrate\`の利用。
- [リアルタイム](https://docs.butterbase.ai/ja/core-concepts/realtime/)：アプリ全般のリアルタイム機能。Substrateのストリームと併用できます。

---

Substrate APIはユーザー単位です。Bearerトークンで識別した呼び出し元自身のSubstrateに対して操作します。パスに\`{app_id}\`は含みません。

<span id="authentication"></span>

## 認証

すべてのエンドポイントで、次のいずれかを使います。

- **Substrate用APIキー**：\`Authorization: Bearer bb_sub_…\`（\`butterbase keys generate --substrate\`で発行）。
- **プラットフォームJWT**（ダッシュボード・Cognitoのセッション）。

Substrate用ではないAPIキー（\`bb_sk_…\`）には403を返します。

エラーは標準の形式です。

\`\`\`json
{ "error": { "code": "AUTH_INVALID_TOKEN", "message": "…", "remediation": "…" } }
\`\`\`

<span id="settings"></span>

## 設定

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/settings | yoloモードなどのユーザー設定を取得 |
| PUT | /v1/me/substrate/settings/yolo | yoloモードを切り替える |

\`\`\`json
PUT /v1/me/substrate/settings/yolo
{ "yolo_mode": true }
\`\`\`

<span id="actions"></span>

## アクション

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/me/substrate/actions/propose | アクションを提案 |
| GET | /v1/me/substrate/actions | 台帳のアクション一覧を取得 |
| GET | /v1/me/substrate/actions/\\{action_id} | アクションを1件取得 |
| POST | /v1/me/substrate/actions/\\{action_id}/approve | 承認待ちのアクションを承認 |
| POST | /v1/me/substrate/actions/\\{action_id}/reject | 承認待ちのアクションを拒否 |

<span id="propose"></span>

### 提案

\`\`\`json
POST /v1/me/substrate/actions/propose
{
  "capability": "record_decision",
  "payload": { "title": "…", "kind": "operational", "rationale": "…" },
  "idempotency_key": "optional-stable-string"
}
\`\`\`

応答：

\`\`\`json
{
  "action_id": "act_01…",
  "verdict": { "result": "auto_approved", "reason": "capability default = auto" },
  "requires_approval": false,
  "result": { "decision_id": "dec_01…" }
}
\`\`\`

判断の値：\`auto_approved\`、\`auto_approved_yolo\`、\`requires_approval\`、\`rejected\`。

<span id="idempotency_key--deduplicating-retries"></span>

#### \`idempotency_key\`：再試行の重複排除

本文の\`idempotency_key\`は任意の文字列です。指定すると、通信の中断やLambdaの再実行があっても、同じ処理を台帳へ重複登録しません。

- **範囲：** Substrateのユーザーごと。別のユーザーは同じキーを使っても競合しません。
- **期間：** 無期限。キーは削除しません。重複を防ぐ処理単位で変わらない値（例：\`meeting_id + ":" + capability\`）を選んでください。呼び出しごとのUUIDは適しません。
- **競合時：** 同じ\`(substrate_user_id, idempotency_key)\`のアクションがあれば、その判断と結果を返し、機能を再実行しません。
- **再取得の応答：** 元と同じ\`action_id\`、判断（再取得の\`conflicts\`は常に空）、結果を返します。ただし**現在の**状態を反映するため、後から承認された場合は\`requires_approval\`が\`false\`です。新規の提案と区別できるよう、トップレベルに\`"replay": true\`を追加します。

例：同じキーを2回送信する場合：

\`\`\`json
// First call — fresh propose
POST /v1/me/substrate/actions/propose
{
  "capability": "record_decision",
  "payload": { "title": "Migrate billing to Stripe", "kind": "strategic" },
  "idempotency_key": "mtg_2026-06-16:record_decision"
}
// → { "action_id": "act_01…", "verdict": { … }, "requires_approval": false, "result": { … } }

// Second call — same key, same user
POST /v1/me/substrate/actions/propose
{ …same body… }
// → { "action_id": "act_01…", "verdict": { … }, "requires_approval": false, "result": { … }, "replay": true }
\`\`\`

機能ごとの本文は[機能の本文](https://docs.butterbase.ai/ja/api-reference/substrate-api/#capability-payloads)を参照してください。

<span id="list"></span>

### 一覧

\`\`\`
GET /v1/me/substrate/actions?status=executed&capability=send_email_draft&limit=25&before=2026-05-28T00:00:00Z
\`\`\`

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| \`status\` | \`proposed\` \\| \`executed\` \\| \`rejected\` | _すべて_ |
| \`capability\` | string | _すべて_ |
| \`limit\` | int（1〜500） | 100 |
| \`before\` | ISO形式の日時 | _現在_ |
| \`source_app_id\` | string | _すべて_ |
| \`source_rule_id\` | string | _すべて_ |

<span id="approve--reject"></span>

### 承認と拒否

\`\`\`
POST /v1/me/substrate/actions/{action_id}/approve
POST /v1/me/substrate/actions/{action_id}/reject
{ "reason": "policy mismatch" }
\`\`\`

いずれも更新したアクションの行を返します。\`proposed\`以外の状態では\`409 wrong_status\`を返します。

<span id="entities"></span>

## エンティティ

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/entities | エンティティ一覧を取得 |
| GET | /v1/me/substrate/entities/\\{entity_id} | エンティティを1件取得 |
| PATCH | /v1/me/substrate/entities/\\{entity_id} | 提案を経由してエンティティを更新 |

\`\`\`
GET /v1/me/substrate/entities?type=person&q=alice&limit=20&count=true
\`\`\`

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| \`type\` | \`person\` \\| \`company\` \\| \`fund\` \\| \`workspace\` \\| \`team\` \\| \`project\` \\| \`event\` \\| \`agent\` \\| \`self\` | _すべて_ |
| \`q\` | string（表示名の検索） | _なし_ |
| \`limit\` | int（1〜200） | 50 |
| \`count\` | \`true\`で応答に\`total\`を含める | \`false\` |

<span id="source-artifacts"></span>

## 元資料

元資料は、会議の文字起こし、メールのスレッド、通話の録音、文書などの全文検索できる永続的な資料です。Substrateはそこから決定、約束、学びを抽出します。約束には、抽出元を示す\`source_artifact_id\`を設定できます。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/source-artifacts | 元資料の一覧、絞り込み、全文検索 |
| GET | /v1/me/substrate/source-artifacts/\\{artifact_id} | 元資料を1件取得（全文の\`content\`を含む） |

\`\`\`
GET /v1/me/substrate/source-artifacts?kind=meeting_transcript&q=billing&limit=20&count=true
\`\`\`

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| \`kind\` | string | _すべて_ |
| \`q\` | string（\`title + summary + content\`の全文検索） | _なし_ |
| \`limit\` | int（1〜200） | 50 |
| \`count\` | \`true\`で応答に\`total\`を含める | \`false\` |

応答：

\`\`\`json
{
  "artifacts": [
    {
      "id": "art_01…",
      "kind": "meeting_transcript",
      "external_system": "fireflies",
      "external_id": "abc123",
      "title": "Weekly product sync — 2026-06-09",
      "summary": "Reviewed phase 6 scope; Alice owns billing migration.",
      "url": "https://fireflies.ai/…",
      "storage_object_id": null,
      "links": { "entity_ids": ["ent_01…"], "project_tags": ["phase-6"] },
      "attrs": {},
      "source_app_id": "app_…",
      "created_at": "2026-06-09T…",
      "updated_at": "2026-06-09T…"
    }
  ]
}
\`\`\`

\`GET /v1/me/substrate/source-artifacts/{artifact_id}\`は、同じ形式に全文の\`content\`を加えて返します。

元資料の保存には、\`POST /v1/me/substrate/actions/propose\`で\`upsert_source_artifact\`を指定します。\`id\`を省略すると\`(external_system, external_id)\`で既存の行を探し、なければ\`art_<ulid>\`を生成する冪等な操作です。インストールしたアプリからの提案は、\`source_app_id\`でそのアプリに関連付けます。

<span id="memory-search"></span>

## メモリーの検索

\`decisions\`、\`commitments\`、\`learnings\`、\`source_artifacts\`を横断して全文検索します。

\`\`\`
GET /v1/me/substrate/memory?q=billing&kinds=decisions,commitments&limit=20
\`\`\`

\`kinds\`には\`decisions\`、\`commitments\`、\`learnings\`、\`source_artifacts\`をカンマ区切りで指定できます。省略するとすべてを検索します。

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| \`q\` | string（全文検索。省略または\`*\`で一覧） | _なし_ |
| \`kinds\` | \`decisions\`、\`commitments\`、\`learnings\`、\`source_artifacts\`のカンマ区切り | _すべて_ |
| \`limit\` | int（1〜200） | 20 |
| \`match\` | \`and\` \\| \`or\` \\| \`phrase\` | \`and\` |

\`q\`が空、省略、または\`*\`の場合、選択した種類の最新項目を\`updated_at DESC\`で返し、\`limit\`で件数を制限します。全文検索の順位付けはせず、\`rank\`は\`null\`です。全件の一覧として利用できます。

\`match\`は複数語の条件です。\`and\`はすべての語を含む（既定値）、\`or\`はいずれかの語を含む、\`phrase\`は語が連続する場合に一致します。省略すると\`match=and\`です。

:::note[検索と一覧の使い分け]
全文検索の順位と関連度（\`rank\`）が必要なら\`GET /v1/me/substrate/memory\`を使います。日時順や種類・元資料・置き換え済みの状態で絞り込むなら\`GET /v1/me/substrate/memory/list\`を使います。同じテーブルを参照しますが、取得方法が異なります。
:::

応答：

\`\`\`json
{
  "results": [
    {
      "id": "dec_01…",
      "kind": "decision",
      "title": "Adopt substrate",
      "body_text": "agent memory needs a single source of truth",
      "rank": 0.18,
      "updated_at": "2026-05-31T…",
      "source_artifact_id": null,
      "supersedes": null,
      "status": "active"
    },
    {
      "id": "art_01…",
      "kind": "source_artifact",
      "title": "Weekly product sync — 2026-06-09",
      "body_text": "Reviewed phase 6 scope; Alice owns billing migration.",
      "rank": 0.12,
      "updated_at": "2026-06-09T…",
      "source_artifact_id": null,
      "supersedes": null,
      "status": null
    }
  ]
}
\`\`\`

すべての結果に次の3つのフィールドを含めます。

| フィールド | 型 | 補足 |
|---|---|---|
| \`source_artifact_id\` | \`string \\| null\` | 抽出元の資料の参照。元資料自体や、抽出元なしで取り込んだ項目では\`null\`。 |
| \`supersedes\` | \`string \\| null\` | 以前の決定を置き換える\`kind: 'decision'\`だけに設定。置き換えた決定のID。 |
| \`status\` | \`string \\| null\` | 決定は\`active\`・\`superseded\`・\`reversed\`・\`expired\`、約束は\`proposed\`・\`confirmed\`・\`fulfilled\`・\`expired\`・\`broken\`など。学びと元資料は\`null\`。 |

<span id="memory-list-chronological-browse"></span>

## メモリーの一覧（日時順）

\`decisions\`、\`commitments\`、\`learnings\`、\`source_artifacts\`を条件で絞り込み、日時順で取得します。全文検索と異なり、常に\`updated_at DESC\`で並び、関連度の順位付けはしません。

\`\`\`
GET /v1/me/substrate/memory/list?source_artifact_id=art_…&kinds=decisions,commitments,learnings&limit=25
\`\`\`

| クエリパラメーター | 型 | 既定値 |
|---|---|---|
| \`kinds\` | \`decisions\`、\`commitments\`、\`learnings\`、\`source_artifacts\`のカンマ区切り | _すべて_ |
| \`source_artifact_id\` | string | _なし_ |
| \`superseded\` | \`true\` \\| \`false\` | _すべて含める_ |
| \`before\` | ISO形式の日時（\`next_before\`のカーソル） | _なし_ |
| \`limit\` | int（1〜100） | 25 |

**\`source_artifact_id\`**は、その元資料に関連する行だけに絞ります。元資料の行自体には同フィールドがないため、この条件では含めません。

**\`superseded\`**が\`false\`なら、\`status='superseded'\`の決定と\`status='expired'\`の約束を除外します。\`true\`または省略なら、すべての状態を返します。

**\`before\`**には前の応答の\`next_before\`をそのまま指定します。ISO形式の日時を使うキーベースのページ分割です。

応答：

\`\`\`json
{
  "results": [
    {
      "id": "dec_…",
      "kind": "decision",
      "title": "…",
      "body_text": "…",
      "updated_at": "…",
      "source_artifact_id": "art_…",
      "supersedes": "dec_…",
      "status": "active"
    }
  ],
  "next_before": "2026-06-09T14:32:00.000Z"
}
\`\`\`

次のページがなければ\`next_before\`は\`null\`です。

決定と約束には\`status\`を設定します。学びと元資料では\`null\`です。\`supersedes\`は、以前の決定を置き換える決定だけに設定します。

<span id="example--list-every-decision-commitment-and-learning-extracted-from-a-meeting"></span>

### 例：会議から抽出した決定、約束、学びの全件取得

\`\`\`
GET /v1/me/substrate/memory/list
  ?source_artifact_id=art_01JXYZ…
  &kinds=decisions,commitments,learnings
  &superseded=false
  &limit=50
\`\`\`

応答：

\`\`\`json
{
  "results": [
    {
      "id": "dec_01JXYZ…",
      "kind": "decision",
      "title": "Ship phase 6 by end of June",
      "body_text": "Agreed in the weekly sync. Alice owns the billing migration.",
      "updated_at": "2026-06-09T14:30:00.000Z",
      "source_artifact_id": "art_01JXYZ…",
      "supersedes": null,
      "status": "active"
    },
    {
      "id": "com_01JXYZ…",
      "kind": "commitment",
      "title": "Alice to deliver billing migration PR by 2026-06-13",
      "body_text": null,
      "updated_at": "2026-06-09T14:30:01.000Z",
      "source_artifact_id": "art_01JXYZ…",
      "supersedes": null,
      "status": "confirmed"
    }
  ],
  "next_before": null
}
\`\`\`

<span id="capabilities"></span>

## 機能

一部の機能には、次の任意フィールドがあります。

| 機能 | 任意フィールド | 補足 |
|---|---|---|
| \`record_commitment\` | \`source_artifact_id\`, \`attrs\` | \`source_artifact_id\`は抽出元の資料への参照（\`source_artifacts(id) ON DELETE SET NULL\`の外部キー）。\`attrs\`は呼び出し元のメタデータ用の任意JSON。 |
| \`upsert_source_artifact\` | \`id\`, \`external_system\`, \`external_id\`, \`summary\`, \`content\`, \`storage_object_id\`, \`url\`, \`links\`, \`attrs\` | 必須：\`kind\`、\`title\`。\`id\`省略時は\`(external_system, external_id)\`で冪等。\`default_policy='auto'\`、\`reversible=true\`、\`yolo_eligible=true\`。応答：\`{ artifact_id, was_insert, before }\`。 |

<span id="capability-payloads"></span>

## 機能の本文

各機能の既定のポリシーとフラグは、[機能の一覧](https://docs.butterbase.ai/ja/core-concepts/substrate/#capabilities-at-a-glance)を参照してください。

以下は機能のZodスキーマで定義されたフィールド名と型です。任意のフィールドは省略できます。

<span id="memory-writes"></span>

### メモリーへの書き込み

\`\`\`
record_decision
  required: title (string), kind ('operational'|'strategic'|'mission'|'vision'|'principle'|'policy_decision')
  optional: rationale (string), salience ('ambient'|'normal'|'archival', default 'normal'), source_artifact_id (string)
  default_policy: auto

record_commitment
  required: description (string), status ('proposed'|'tentative'|'confirmed'|'fulfilled'|'expired'|'broken')
  optional: from_entity (string), to_entity (string), amount (number), unit (string), due_at (string, ISO 8601), source_artifact_id (string), attrs (object)
  default_policy: auto

record_learning
  required: title (string), description (string)
  optional: resolution_taken (string), related_decision_id (string), source_artifact_id (string)
  default_policy: auto

record_principle
  required: title (string), applies_to (object, e.g. {capability: "send_email_draft", target_role: "investor"}), constraint_spec (object, e.g. {type: "max_per_week", params: {n: 2}})
  optional: rationale (string), salience ('ambient'|'normal'|'archival', default 'ambient')
  default_policy: approval_required

supersede_decision
  required: old_decision_id (string), new_title (string), kind ('operational'|'strategic'|'mission'|'vision'|'principle'|'policy_decision')
  optional: new_rationale (string)
  default_policy: approval_required

retire_principle
  required: principle_id (string), reason (string)
  default_policy: approval_required
\`\`\`

<span id="entity-writes"></span>

### エンティティへの書き込み

\`\`\`
upsert_entity
  required: type ('person'|'company'|'fund'|'workspace'|'team'|'project'|'event'|'agent'|'self'), display_name (string)
  optional: id (string), primary_email (string, email), canonical_keys (object), linked_app_user_id (string, uuid), linked_app_id (string), attrs (object)
  default_policy: auto
  note: dedups by id > canonical_keys > primary_email

update_entity
  required: id (string)
  optional: display_name (string), primary_email (string, email), attrs (object)
  default_policy: auto
  note: replaces attrs wholesale; prefer patch_entity for partial updates

patch_entity
  required: id (string)
  optional: display_name (string), primary_email (string, email), attrs_patch (object, RFC 7396 merge-patch), if_updated_at (string, datetime, optimistic lock)
  default_policy: auto

merge_entities
  required: loser_id (string), winner_id (string), reason (string)
  default_policy: approval_required

delete_entity
  required: id (string), reason (string)
  default_policy: approval_required
\`\`\`

<span id="source-artifacts-1"></span>

### 元資料

\`\`\`
upsert_source_artifact
  required: kind (string), title (string)
  optional: id (string), external_system (string), external_id (string), summary (string), content (string), storage_object_id (string), url (string), links ({entity_ids?: string[], project_tags?: string[]}), attrs (object)
  default_policy: auto
  note: idempotent by (external_system, external_id) when id is omitted
\`\`\`

<span id="revert--bulk-revert"></span>

### 取り消しと一括取り消し

\`\`\`
revert_action
  required: action_id (string)
  default_policy: auto

bulk_revert_actions
  required: action_ids (string[], 1–200 items), reason (string)
  default_policy: approval_required
\`\`\`

<span id="side-effecting"></span>

### 外部への操作

\`\`\`
send_email_draft
  required: to (string), subject (string), body (string)
  optional: target_role (string)
  default_policy: approval_required
\`\`\`

<span id="daily-snapshots"></span>

## 日次スナップショット

注意ルールの\`snapshot_predicate\`条件は、スナップショットを基に評価します。

\`\`\`
GET /v1/me/substrate/snapshots?days=7
\`\`\`

応答：

\`\`\`json
{
  "snapshots": [
    { "snapshot_date": "2026-05-31", "entity_count": 12, "decision_count": 8, "…": "…" }
  ]
}
\`\`\`

<span id="attention-rules"></span>

## 注意ルール

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/attention-rules | ルール一覧を取得 |
| GET | /v1/me/substrate/attention-rules/\\{rule_id} | ルールを1件取得 |
| POST | /v1/me/substrate/attention-rules | ルールを作成 |
| PUT | /v1/me/substrate/attention-rules/\\{rule_id} | ルールを更新 |
| DELETE | /v1/me/substrate/attention-rules/\\{rule_id} | ルールを削除 |
| POST | /v1/me/substrate/attention-rules/\\{rule_id}/enable | 有効にする |
| POST | /v1/me/substrate/attention-rules/\\{rule_id}/disable | 無効にする |
| POST | /v1/me/substrate/attention-rules/preview | 今日のスナップショットでルールの本文を試す |
| GET | /v1/me/substrate/attention-rules/\\{rule_id}/firings | 発火履歴を取得 |

<span id="rule-body"></span>

### ルールの本文

\`\`\`json
{
  "name": "weekly digest",
  "description": "Monday morning summary",
  "trigger_cron": "0 9 * * 1",
  "condition_mode": "snapshot_predicate",
  "condition": { ">": [ { "var": "entity_count" }, 0 ] },
  "action_capability": "send_email_draft",
  "action_payload_template": {
    "to": "you@example.com",
    "subject": "Weekly digest",
    "body": "{{entity_count}} entities."
  },
  "enabled": true,
  "max_fires_per_day": 1
}
\`\`\`

| フィールド | 必須 | 補足 |
|---|---|---|
| \`name\` | はい | 表示名 |
| \`trigger_cron\` | はい | 標準の5フィールドのcron式（UTC） |
| \`condition_mode\` | はい | \`snapshot_predicate\`は今日のスナップショットに対してJSON-Logicを評価します。\`row_query\`は行クエリとして条件を実行する上級者向けの指定です。 |
| \`condition\` | はい | JSON-Logicオブジェクト。利用できる変数は\`condition_mode\`により異なります。 |
| \`action_capability\` | はい | 発火時に提案する機能 |
| \`action_payload_template\` | はい | 一致した値で\`{{var}}\`を置き換えるオブジェクト |
| \`enabled\` | いいえ | 既定値は\`true\`。 |
| \`max_fires_per_day\` | いいえ | 1日あたりの提案件数の上限 |

<span id="preview"></span>

### プレビュー

\`\`\`json
POST /v1/me/substrate/attention-rules/preview
{ <same shape as rule body, name optional> }
\`\`\`

応答：

\`\`\`json
{
  "bindings_count": 3,
  "sample_proposals": [
    { "binding": { "entity_count": 12 }, "rendered_payload": { … }, "would_require_approval": false }
  ],
  "skip_reason": null
}
\`\`\`

スナップショットがない、または条件を評価できない場合、\`skip_reason\`を設定し、\`bindings_count\`は0です。

<span id="outbox-targets"></span>

## Outboxの送信先

\`capability X\`のアクションを実行すると、登録済みのOutboxの送信先へ本文をPOSTします。HMAC署名を付け、失敗時は間隔を延ばしながら再試行します。

| メソッド | パス | 用途 |
|--------|------|---------|
| GET | /v1/me/substrate/outbox-targets | 全送信先の一覧を取得 |
| PUT | /v1/me/substrate/outbox-targets/\\{capability} | 送信先を登録または置換 |
| DELETE | /v1/me/substrate/outbox-targets/\\{capability} | 送信先を削除 |

\`\`\`json
PUT /v1/me/substrate/outbox-targets/send_email_draft
{
  "webhook_url": "https://example.com/hooks/substrate",
  "signing_secret": "min-8-chars",
  "source_app_id": "app_optional_scope"
}
\`\`\`

\`source_app_id\`は任意です。指定すると、そのアプリが提案したアクションだけを送信します。

<span id="webhook-delivery"></span>

### Webhookの配信

\`\`\`
POST https://example.com/hooks/substrate
Content-Type: application/json
X-Butterbase-Signature: sha256=<hex>
X-Butterbase-Delivery: <uuid>

{
  "action_id": "act_01…",
  "capability": "send_email_draft",
  "payload": { … the rendered action payload … },
  "executed_at": "2026-05-31T…"
}
\`\`\`

\`signing_secret\`を使い、本文の生データに対するHMAC-SHA-256を計算して署名を検証してください。

<span id="websocket-stream"></span>

## WebSocketストリーム

呼び出し元のSubstrateのすべての変更をリアルタイム配信します。

\`\`\`
GET /v1/me/substrate/stream
\`\`\`

<span id="browser-flow"></span>

### ブラウザーからの接続

ブラウザーのWebSocket接続では独自のヘッダーを送信できないため、1回限りのチケットを使います。

1. チケットを発行します（Cognitoまたは\`bb_sub_\`のBearer）。

   \`\`\`
   POST /v1/me/substrate/ws-ticket
   \`\`\`

   \`\`\`json
   { "ticket": "wst_…", "expires_in": 60 }
   \`\`\`

2. \`?ticket=\`を指定して接続します。

   \`\`\`
   wss://api.butterbase.ai/v1/me/substrate/stream?ticket=wst_…
   \`\`\`

チケットは**1回限り**で、60秒で失効します。再使用や期限切れの場合、\`1008 unauthenticated\`で接続を閉じます。

<span id="server-side-flow"></span>

### サーバーからの接続

サーバーなどのクライアントは、WebSocket接続のAuthorizationヘッダーにSubstrate用のキーを指定できます。

\`\`\`
GET /v1/me/substrate/stream
Upgrade: websocket
Authorization: Bearer bb_sub_…
\`\`\`

代わりにクエリ文字列でも指定できます。

\`\`\`
wss://api.butterbase.ai/v1/me/substrate/stream?token=bb_sub_…
\`\`\`

<span id="app-function-flow"></span>

### アプリの関数からの接続

組織に紐付けたアプリでは、Substrateキーをブラウザーへ渡さずに、自分のユーザー用のチケットを発行できます。デプロイした関数内で次を呼び出します。

\`\`\`ts
const { ticket, expires_in } = await ctx.substrate.wsTicket();
\`\`\`

内部のサーバー間通信で、アプリに紐付けた組織の60秒・1回限りのチケットを返します。ブラウザーへ渡し、\`?ticket=\`で接続してください。エンドユーザー向けのアプリではこの方法を推奨します。[ブラウザーの例](https://docs.butterbase.ai/ja/core-concepts/substrate/#8-stream-live-updates-to-a-ui)を参照してください。

<span id="frames"></span>

### フレーム

\`\`\`json
// First frame on open:
{ "type": "hello", "ts": 1780198304 }

// Subsequent frames, one per change — envelope only, no row payload:
{ "tbl": "entities",               "op": "insert", "id": "ent_…",  "org": "…" }
{ "tbl": "action_ledger",          "op": "insert", "id": "act_…",  "org": "…" }
{ "tbl": "decisions",              "op": "insert", "id": "dec_…",  "org": "…" }
{ "tbl": "commitments",            "op": "update", "id": "com_…",  "org": "…" }
{ "tbl": "learnings",              "op": "insert", "id": "lrn_…",  "org": "…" }
{ "tbl": "attention_rules",        "op": "update", "id": "rule_…", "org": "…" }
{ "tbl": "attention_rule_firings", "op": "insert", "id": "fire_…", "org": "…" }
\`\`\`

変更フレームの形式は\`{ org, op, tbl, id }\`です。

| フィールド | 意味 |
|---|---|
| \`org\` | 変更が属する組織。組織単位のストリームで、チケットまたはキーに紐付いた組織の変更だけを受信します。 |
| \`op\` | \`insert\`、\`update\`、\`delete\` |
| \`tbl\` | 変更された実テーブル（例：\`entities\`、\`action_ledger\`、\`decisions\`） |
| \`id\` | 変更された行のID |

本文のデータは配信しません。クライアントがIDを使って変更された行を再取得してください。

<span id="close-codes"></span>

### 終了コード

| コード | 意味 |
|---|---|
| 1000 | 通常終了（クライアントから切断） |
| 1008 | チケットがない、期限切れ、再使用、またはトークンが無効 |

<span id="sdk--cli"></span>

## SDKとCLI

- **CLI**：すべてのコマンドは[\`butterbase substrate\`](https://docs.butterbase.ai/ja/cli/substrate/)を参照してください。
- **TypeScript SDK**：\`butterbase.substrate.*\`にHTTP APIと対応するメソッドがあります。
- **関数内**：\`ctx.substrate.*\`（\`propose\`、\`getEntity\`、\`findEntities\`、\`searchMemory\`、\`listMemory\`）を使います。[Substrate](https://docs.butterbase.ai/ja/core-concepts/substrate/)を参照してください。`,
};
