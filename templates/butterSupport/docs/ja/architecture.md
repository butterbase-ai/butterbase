# 構成と環境変数

[日本語README](../../README.ja.md) · [英語の原文](../../README.md#architecture-in-one-diagram)

問い合わせはウィジェットからPostgresとチケットごとのエージェントへ渡り、管理画面にはrealtime・WebSocketで配信します。製品への操作はsubstrate outboxを経由します。原文の構成図です。

```
Customer's product                              YOUR cloned support recipe
─────────────────                              ────────────────────────────
                                               ┌──────────────────────────┐
[end user]                                     │  founder console (SPA)   │
   │                                           │  - inbox, ticket detail  │
   ▼                                           │  - draft approval        │
[<script async src=widget.js                   │  - settings, setup       │
   data-app-id=…>]                             └──────┬───────────────────┘
   │ POST + anonymous visitor_token                   │ realtime + DO WS
   │ (+ optional identify())                          │
   ▼                                           ┌──────▼───────────────────┐
[widget-ingest] ─────►  Postgres ◄─── realtime ──────┤ SupportTicketDO    │
   │                       │                         │ (1 per ticket)     │
   ▼                       │                         │  • search_docs ────┼──► RAG
[upsert_source_artifact]   │                         │  • propose_*       │
   │                       │                         └────────────────────┘
   ▼                       │                                  │
┌──────────┐    propose    │                                  │ propose
│ substrate│◄──────────────┘                                  │
└────┬─────┘                                                  │
     │ outbox webhook                                         │
     │ (HMAC, idempotency)                                    │
     ▼                                                        ▼
[your product's            ┌─────────────────────────┐
 action handlers]          │ execute-escalation       │  ← lives in recipe
   resend_verification     │  via Composio Slack/Gmail│
   retry_webhook           └─────────────────────────┘
   flag_as_bug
   apply_account_credit
```

## 複製時の環境変数

| 関数・DO | 変数 |
|---|---|
| `request-doc-upload-url`、`ingest-docs`、`delete-docs-source`、`fetch-ai-usage`、`refresh-docs` | アプリに限定した`BUTTERBASE_API_KEY`。複製時の`auto_mint_api_key`で発行 |
| `SupportTicketDO` | `BUTTERBASE_API_KEY`、`BUTTERBASE_API_URL`、`BUTTERBASE_APP_ID`、`RAG_COLLECTION`、`DEFAULT_MODEL`、`HAIKU_MODEL` |
| `execute-escalation` | outbox登録後に設定する`SUBSTRATE_OUTBOX_SECRET`。`X-Butterbase-Signature`のHMACを検証 |

`SUBSTRATE_OUTBOX_SECRET`を省略すると、警告を記録して検証を省きます。原文では開発専用の挙動とされています。本番では必ず設定してください。

## フロントエンド

Viteのビルド時に設定します。

```
VITE_BUTTERBASE_APP_ID=<your_clone_app_id>
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
VITE_BUTTERBASE_SUBDOMAIN=<your_subdomain>
```

サービスキーはブラウザー向けの`VITE_*`に含めず、関数側の環境変数へ設定してください。
