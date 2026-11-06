# ファイル構成と開発コマンド

[クイックスタート](../../QUICKSTART.ja.md) · [英語の原文](../../QUICKSTART.md#6-repo-layout)

## ファイル構成

```
butterbaseCRM/
├── frontend/                  ← the React app you just ran
│   ├── src/
│   │   ├── pages/             ← 19 page components (Companies, Deals, Meetings, Campaigns, Social, Login, …)
│   │   ├── components/        ← shadcn/ui-based UI primitives + feature components
│   │   ├── hooks/             ← useCompanies, useDeals, useNotes, useAgentRealtime, …
│   │   ├── lib/butterbase.ts  ← the SDK client — every API call flows through here
│   │   ├── lib/realtime.ts    ← WebSocket subscription wiring
│   │   ├── lib/activity.ts    ← writes activity-log rows after mutations
│   │   ├── routes/            ← React Router v7 config
│   │   └── App.tsx            ← Router + QueryClient + RealtimeBoot
│   └── .env.local             ← you just created this
│
├── backend/                   ← READ-ONLY MIRROR of the live platform state
│   ├── schema.json            ← 29 tables, indexes
│   ├── rls/policies.sql       ← workspace-scoped RLS policies
│   ├── functions/             ← 56 functions, one folder each (handler.ts + function.json)
│   ├── auth/, storage/objects.json, realtime.json, ai.json, integrations/
│   └── sync.sh                ← refreshes the mirror from the live app
│
├── docs/butterbase/           ← Journey artifacts
│   ├── 01-idea.md             ← Product vision
│   ├── 02-plan.md             ← Schema + RLS + function design
│   ├── 03-preflight.md        ← Account / MCP / app-id check
│   └── …                      ← build log, frontend spec, deferred items
│
└── .butterbase/config.json    ← pinned app id + snapshot
```

## 変更する場所

| 対象 | ファイル |
|---|---|
| ページ・ルート・レイアウト | `frontend/src/pages/`・`frontend/src/routes/` |
| 再利用するUI | `frontend/src/components/` |
| データ取得・更新 | `frontend/src/hooks/use*.ts` |
| SDKの設定 | `frontend/src/lib/butterbase.ts` |
| Realtime | `frontend/src/lib/realtime.ts` |
| 見た目 | `frontend/tailwind.config.js`・`frontend/src/index.css` |

`backend/`のファイルはミラーです。実アプリの変更はMCPの`manage_schema`・`manage_rls`・`deploy_function`や管理画面から行います。その後`cd backend && ./sync.sh`でミラーを更新し、生成結果を確認してコミットします。

## よく使うコマンド

`frontend/`から実行します。

```bash
npm run dev        # Vite dev server with HMR
npm run build      # tsc -b && vite build  → dist/
npm run preview    # serve the production build locally
npm run lint       # ESLint
```

`backend/`から実行します。`BUTTERBASE_API_KEY`が必要です。

```bash
./sync.sh          # pull current schema/RLS/functions/auth/etc. into this folder
```

コードのスナップショット同期です。詳しくは[同期の仕組み](repo-sync.md)を参照してください。

```bash
butterbase repo pull                       # download the latest code snapshot
butterbase repo push --message "..."       # upload your working tree as a new snapshot
butterbase repo status                     # show pinned vs. latest snapshot
```

日本語表示のテストは、モノレポのルートから`node --import tsx --test templates/i18n.test.ts`で実行します。
