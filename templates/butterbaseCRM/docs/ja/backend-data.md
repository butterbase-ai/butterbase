# データ構造とRLS

[日本語バックエンドREADME](../../backend/README.ja.md) · [英語の原文](../../backend/README.md#data-model--where-each-entity-lives)

substrateへの移行後、会社・連絡先・商談・会議・参加者・CRMエンティティのメモはsubstrateで扱います。`schema.json`には対応する基本エンティティのテーブルがありません。移行仕様は[設計文書](../superpowers/specs/2026-06-10-substrate-only-refactor.md)を参照してください。

Postgresは、ワークスペースや配信設定などを保存します。原文の構成図です。

```
auth.users (managed by Butterbase, not in our schema)
  └─ user_id (uuid, JWT subject)

workspaces
  ├─ memberships          # user ↔ workspace
  ├─ pending_invites      # invite tokens (admin-only)
  ├─ app_allowlist        # login gate
  ├─ activities           # append-only polymorphic event log (substrate ent_ ids in payload)
  ├─ attachments          # file metadata; bytes in storage
  ├─ notes                # free-form notes (entity_type may reference a substrate id)
  ├─ custom_fields        # workspace-scoped field defs (values live in substrate attrs)
  ├─ saved_views          # per-user saved filters
  ├─ sync_settings        # Google autosync toggle + cursors
  ├─ workspace_integrations + integration_state + reconciler_cursor   # Composio bindings
  ├─ enrichment_settings  # which agent enriches what
  ├─ agent_threads + agent_messages + agent_proposals + deal_proposals
  ├─ campaigns + campaign_lists + campaign_list_members + campaign_sends
  ├─ comment_campaigns + comment_campaign_items + workspace_competitors
  └─ social_posts + social_post_sends + social_comments + social_reply_inbox
```

関数内では`ctx.substrate`、ブラウザーでは`substrate-proxy`・`list-substrate-entities`を使います。`crm-upsert-meeting`・`ingest-gmail`の関数が読み書きの例です。

## メンバー資格で制御する

多くのワークスペーステーブルは次の条件で制御します。

```sql
workspace_id IN (
  SELECT m.workspace_id FROM memberships m
   WHERE m.user_id = current_user_id()::uuid
)
```

`current_user_id()`は`text`を返すため、`::uuid`が必要です。省くと`RLS_TYPE_MISMATCH: operator does not exist: uuid = text`になります。

`notes`と`attachments`の更新・削除は、作成者・アップロード者本人か、ワークスペースの`owner`・`admin`に限定します。商談と会議はsubstrateのエンティティなので、Postgresポリシーを持ちません。

## ミラーから分からない点

原文時点の`rls/policies.json`には、次の10テーブルのポリシーがありません。

`campaigns`、`campaign_lists`、`campaign_list_members`、`campaign_sends`、`comment_campaigns`、`comment_campaign_items`、`social_comments`、`social_reply_inbox`、`workspace_competitors`、`reconciler_cursor`。

ミラーだけではRLSが有効か判定できません。ワークスペースの分離を前提にする前に、`manage_rls`か`butterbase rls list`で実環境を確認してください。

`memberships`のSELECTは自分の行だけです。チーム全員の行は取得できません。名前の表示に関する残件は[02-plan.md](../butterbase/02-plan.md)を参照してください。

## INSERTの例外と追記専用のデータ

- `workspaces_insert_self`：`owner_user_id`が自分ならワークスペースを作れます。
- `memberships_insert_founding_owner`：自分が作ったワークスペースへ、自分の`role='owner'`を追加できます。初回作成前に管理者資格を要求する循環を避けます。
- 活動履歴：メンバーは`actor_user_id`が自分の行をINSERTできます。画面からUPDATE・DELETEはできません。
- 招待：`pending_invites`のSELECT・INSERT・DELETEは`owner`・`admin`のみです。招待を受ける人はサービス実行の`accept-invite`でトークンを引き換えます。

全体は[policies.sql](../../backend/rls/policies.sql)を参照してください。
