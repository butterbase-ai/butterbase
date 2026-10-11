# 関数とスキーマの注意

[日本語バックエンドREADME](../../backend/README.ja.md) · [英語の原文](../../backend/README.md#functions)

以下は原文の一部のスナップショットです。SNS投稿・リード検索など、一覧にない関数もあります。各`function.json`がトリガー・タイムアウト・メモリ・エージェント公開の正本です。

| 関数 | 起動 | 処理 |
|---|---|---|
| `accept-deal-proposal` | http | 商談のsubstrate提案を承認し、活動を記録 |
| `accept-invite` | http | 招待トークンを引き換え、メンバーを作り招待を削除。サービス実行 |
| `agent-chat` | http | substrateを使うチャット。旧`brief_meeting`ツールは削除 |
| `agent-proposals-expire` | cron | `expires_at < now()`の保留提案を期限切れにする |
| `ai-search` | http | 自然文を許可済みテーブル・列・演算子の検索仕様へ変換し、サーバーで検証・実行 |
| `ai-suggest-filters` | http | `object_type`向けの`{ filters, suggested_name, sort }`を返す |
| `auto-sync-google` | cron | 5分ごとに有効なワークスペース・利用者のGmailと予定を取り込み、補完を起動 |
| `check-allowlist` | http | ログイン許可を判定し、最初の認証利用者をオーナーにする |
| `cleanup-orphan-integrations` | cron | ワークスペース・利用者がない連携を日次で削除 |
| `create-campaign-list` | http | メールと変数のスナップショットを持つsubstrateエンティティの配信リストを作る |
| `crm-record-activity` | http | `(workspace_id, kind, payload->>dedupe_key)`で重複を除き活動を追加 |
| `crm-upsert-meeting` | http | substrateの会議をupsert。`as_user_id`と`_custom_fields_replace`に対応 |
| `enrich-company` | http | People APIで会社のロゴ・説明・所在地を補完 |
| `enrich-person` | http | LinkedInプロフィールから連絡先を補完 |
| `find-duplicates` | http | 移行後のスタブ。substrate検索への書き換えが残件 |
| `get-meeting-notes` | http | 文字起こしと関連する決定事項・約束・学びを取得 |
| `ingest-calendar` | http | `last_synced_at`を基準に1時間重ねて予定を増分取得 |
| `ingest-gmail` | http | 会社・連絡先をsubstrateへ提案し、`ent_*`を活動へ記録 |
| `ingest-meeting-transcript` | http | 文字起こしを`source_artifact`に保存し、`status=done`へ更新・抽出を起動 |
| `invite-member` | http | Gmailで招待し、`app_allowlist`へ招待先を追加 |
| `list-substrate-entities` | http | ブラウザーから`bb_sub_*`キーなしでエンティティを読む窓口 |
| `migrate-meetings-to-substrate` | http | 会議・参加者・カスタム値の冪等な1回限りの移行 |
| `pause-campaign` | http | 配信の一時停止・再開・中止。中止で待機中の送信も変更 |
| `process-campaign-sends` | cron | 送信予定をGmailへ送り、処理単位と24時間の上限を適用 |
| `propose-deals` | http | 移行後のスタブ。substrateを読み提案行を作る実装が残件 |
| `register-integration` | http | ワークスペース・利用者へComposio連携を結びつける |
| `start-campaign` | http | 下書きを有効にし、リストから送信行を作る |
| `start-meeting-bot` | http | 場所・メモの会議URLへボットを送る。`bot_id`を記録し、費用上限・冪等性を適用 |
| `notetaker-webhook` | http/HMAC | JWTなしで会議イベントを受け、`transcript.done`を取り込む。初回登録が必要 |
| `substrate-proxy` | http | ブラウザー向けの窓口。上限5000 |
| `summarize-company` | http | 呼び出した利用者のRLSに従い、会社の2文の要約を生成 |
| `trigger-enrichment` | http | 移行後のスタブ。substrateで未入力項目を探す実装が残件 |
| `unregister-integration` | http | Composio連携を解除 |

## 認証と実行

HTTP関数は既定で`butterbase_user`としてRLSを適用します。`accept-invite`などRLSを迂回する関数は`auth: none`で`butterbase_service`を使います。招待トークンが認可となり、招待先に既存の管理者資格を要求しません。cronはサービス実行です。接続済みアプリでは`ctx.substrate`を自動注入します。

## スキーマの注意

- 文字列のdefaultはSQLの引用符込みで送ります。例は`"default": "'lead'"`です。取得結果の`"default": "lead"`をそのまま適用すると、列参照のエラーになります。
- `manage_schema apply`は全体状態の差分です。1テーブル追加でも既存テーブル全件を含めます。省略したテーブルには`SCHEMA_DESTRUCTIVE_CHANGE`が出ます。
- 認証ユーザーはアプリDBの外にあるため、`users`へのFKは作りません。`user_id`・`created_by`・`actor_user_id`は`uuid`です。
- フロントエンドZIPはスラッシュ区切りにします。`frontend/zip-dist.cjs`がこれを生成します。
- ブラウザーのWebSocket認証は`?token=`です。任意のAuthorizationヘッダーは追加できません。
- `getDownloadUrl()`には保存した`objectId`のUUIDを渡します。内部パスの`objectKey`はURLではありません。
- `butterbase_service`は`CREATE FUNCTION`・`CREATE TRIGGER`を実行できません。活動履歴は各更新後にアプリコードで作ります。
