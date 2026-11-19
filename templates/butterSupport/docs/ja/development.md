# リポジトリ構成と開発

[日本語README](../../README.ja.md) · [英語の原文](../../README.md#repo-layout)

`backend/`は実アプリの読み取り用ミラー、`durable-objects/`はDOのソース、`frontend/`は管理画面とウィジェットです。`docs/butterbase/`に設計・構築ログ・残件を記録しています。原文の構成図です。

```
.
├── README.md                   # this file
├── agents/
│   └── support-overview.json   # platform-agent spec — re-imported on clone
├── backend/                    # read-only mirror of the live app (schema, RLS, functions, DOs, configs)
├── durable-objects/            # SupportTicketDO / WidgetTicketDO source
├── DEPLOY.md                   # frontend deploy checklist (widget.js + subdomain)
├── frontend/                   # Vite + React console + widget
│   ├── src/console/            # Founder console SPA
│   ├── src/widget/             # Embeddable customer widget
│   └── HANDOFF.md              # Decisions & known issues from frontend build
└── docs/butterbase/            # Build journey artifacts
    ├── 00-state.md             # Journey state (cursor + stages)
    ├── 01-idea.md              # The strategic brief
    ├── 02-plan.md              # Full architectural plan
    ├── 03-preflight.md         # Account / app provisioning
    ├── 03b-docs-cache.md       # Cached Butterbase docs
    ├── 04-build-log.md         # Stage-by-stage build log
    ├── 05-frontend-spec.md     # Spec the spawned Claude built from
    ├── 06-v1-deferred.md       # Known limitations + post-v1 work
    └── 07-template.md          # Template publication details
```

## ローカル開発

```bash
# Frontend
cd frontend
cp .env.example .env.local
# fill in VITE_BUTTERBASE_APP_ID etc.
npm install
npm run dev    # http://localhost:5173

# Functions, DO, schema — use MCP via Claude / Cursor, or the CLI:
butterbase functions deploy ./backend/functions/<name>/handler.ts
butterbase do deploy ./durable-objects/support-ticket-do.ts
butterbase schema apply ./backend/schema.json
```

後半のCLIコマンドはリモートの関数・DO・スキーマを変更します。導入先のアプリを確認して実行してください。

日本語表示の回帰テストはモノレポのルートから`node --import tsx --test templates/i18n.test.ts`で実行します。表示言語、入力値の補間、API識別子の保持、保存済みのウィジェット言語を確認します。

## 貢献

まとまった変更では`docs/butterbase/02-plan.md`、既知の残件の解決では`06-v1-deferred.md`を更新します。`01-idea.md`の安全に関する制約2・3・9・10を緩める場合は、先に議論してください。

Apache-2.0です。[LICENSE](../../../../LICENSE)を参照してください。
