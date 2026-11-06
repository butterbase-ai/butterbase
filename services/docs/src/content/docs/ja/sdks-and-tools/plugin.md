---
title: Claude Codeプラグイン
description: Butterbaseアプリの作成・デプロイ・デバッグを支援するClaude Codeプラグインです。
---

**Butterbase Skills**は、MCPサーバーを自動設定し、よく使う開発工程を案内するClaude Codeプラグインです。

<span id="installation"></span>

## インストール

```bash
# Add the Butterbase marketplace
claude plugin marketplace add https://github.com/butterbase-ai/butterbase-skills

# Install the plugin
claude plugin install butterbase-skills@butterbase-skills
```

APIキーを設定します。

```bash
export BUTTERBASE_API_KEY=bb_sk_your_key_here
```

<span id="whats-included"></span>

## 含まれる機能

<span id="mcp-server-auto-configuration"></span>

### MCPサーバーの自動設定

同梱の`.mcp.json`がButterbase MCPサーバーへの接続を設定します。手動設定なしで、すぐに全ツールとプロンプトを利用できます。

<span id="always-on-context-claudemd"></span>

### 常時参照するコンテキスト（CLAUDE.md）

Claudeが常時参照するButterbaseの情報を用意します。
- 環境変数（`BUTTERBASE_API_KEY`、`VITE_API_URL`など）
- 基本工程（初期化 → スキーマ → RLS → 認証 → デプロイ）
- 実装パターン（ストレージのobjectId、関数のResponse、RLSロール）
- ドキュメント（`butterbase_docs`の全トピック）

<span id="skills-and-slash-commands"></span>

### スキルとスラッシュコマンド

案内付きスキル39種とスラッシュコマンド34種を用意しています。該当する依頼でスキルが自動読み込みされ、スラッシュコマンドでは直接呼び出せます。

**開発全体の案内** — `/butterbase-skills:journey`がアイデアから公開までを進めます。アイデア → 計画 → 事前確認 → 文書 → スキーマ → RLS → 認証 → ストレージ → 関数 → リアルタイム → Durable Objects → AI → RAG → エージェント → フロントエンド → 公開後の動作確認の順です。必要に応じてSubstrate接続、テンプレート公開、ハッカソン提出も行います。各段階には`/butterbase-skills:idea`、`/butterbase-skills:plan`、`/butterbase-skills:journey-schema`、`/butterbase-skills:submit`などの個別コマンドもあります。

**機能別のスキル：**

| スキル | スラッシュコマンド | 内容 |
|-------|--------------|-------------|
| Build App | `/butterbase-skills:build-app` | アプリ作成、スキーマ設計、RLS、認証、関数、フロントエンド公開までの案内 |
| Schema Design | `/butterbase-skills:schema` | 列型、インデックス、データモデルを含むスキーマDSLの説明 |
| Deploy Frontend | `/butterbase-skills:deploy` | React、Next.js、静的HTMLの公開手順 |
| Debug RLS | `/butterbase-skills:debug-rls` | ロールのシミュレーションによるRLSのデバッグ |
| Function Dev | `/butterbase-skills:function` | 関数のハンドラー、トリガー、動く実装例 |
| Auth Setup | `/butterbase-skills:auth` | OAuth、認証フック、JWTの有効期間、サービスキー |
| Storage | `/butterbase-skills:storage` | アップロード、ダウンロード、署名付きURL、ACL |
| Realtime | `/butterbase-skills:realtime` | WebSocket購読、プレゼンス、対戦状態 |
| Durable Objects | `/butterbase-skills:durable-objects` | チャット、レート制限、長時間動くエージェントなどの状態管理 |
| AI | `/butterbase-skills:ai` | チャット、埋め込み、モデル、既定値、BYOK、使用量 |
| RAG | `/butterbase-skills:rag` | ナレッジベース、文書取り込み、意味検索、質問応答 |
| Integrations | `/butterbase-skills:integrations` | メール、SMS、Slack、カレンダー、CRMなどとの組み込み連携 |
| Payments | `/butterbase-skills:payments` | `manage_billing`によるStripe Connect決済 |
| Substrate | `/butterbase-skills:substrate` | ユーザーごとのエージェント記憶を読み書き |
| Migrations | `/butterbase-skills:migrations` | リージョン間移動、進捗確認、中止、移動の取り消し |
| Contributing | `/butterbase-skills:contributing` | モノレポへの貢献手順 |

専用コマンドのないスキルは、`agents`（宣言的LLM・ツールグラフ）、`meetings`（会議ボットと文字起こし）、`templates`（公開テンプレートの公開・複製）です。

<span id="alternative-cli-setup"></span>

## CLIでの代替設定

スキルを使わず、MCP接続だけが必要ならCLIを使います。

```bash
butterbase plugin setup
```

プロジェクトの初期化中にも設定できます。

```bash
butterbase init react-vite
```

どちらもMCP接続用の`.mcp.json`を生成します。

<span id="local-development"></span>

## ローカル開発

モノレポをローカルで動かす場合、MCPサーバーURLの既定値は`http://localhost:4000/mcp`です。環境変数に設定します。

```bash
export CONTROL_API_URL=http://localhost:4000
```

<span id="testing-locally"></span>

## ローカルでのテスト

開発時はローカルのディレクトリからプラグインを読み込みます。

```bash
claude --plugin-dir /path/to/butterbase-plugin
```

<span id="source"></span>

## ソース

- **GitHub**：[Butterbase Skills](https://github.com/butterbase-ai/butterbase-skills)
- **ライセンス**：MIT
