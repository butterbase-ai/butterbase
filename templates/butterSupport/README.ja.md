# Butter Support

[English](README.md) | 日本語

製品の実データを参照して問い合わせを診断する、Butterbase向けのOSS AIサポートアプリです。チケットごとのDurable Objectがエージェントを動かし、推論を管理画面へ配信します。対応履歴をsubstrateへ記録するため、CRMなどの別アプリからも参照できます。

基本構成は、ヘルプセンターのURLを登録して文書検索を使うものです。拡張構成では、製品アプリが投影したシグナルを読み、承認を経る操作をsubstrate outboxへ提案します。Butterbase上に製品を持たない会社でも基本構成を使えます。

原文のv1説明は、複製ごとに1テナントを置き、顧客向け返信を運営者が承認する設計記録です。現行フロントエンドには自律性モードの設定もあります。初期値は`draft_for_approval`です。現在の送信条件は管理画面で確認してください。

## 利用者に見える機能

- 顧客：埋め込みウィジェットで問い合わせを送信します。エージェントは文書と、接続済みならアカウント・エラー・決済状態を参照します。
- 運営者：受信トレイ、チケット詳細、推論の配信、返信下書きの編集・承認、ヘルプ文書、引き継ぎ先、チーム設定を使います。
- 拡張構成：認証失敗・決済失敗・試用期限などのシグナルを参照し、製品側で実行する操作を提案できます。

## 構成

| 要素 | 内容 |
|---|---|
| Postgres | 原文時点で20テーブル。チケット、メッセージ、診断、傾向、引き継ぎ、文書、設定、メンバー、活動ログなど |
| 関数 | 原文時点で30関数。認証フック、ウィジェット受付、チケット操作、管理・初期設定、引き継ぎ、cron |
| Durable Objects | `SupportTicketDO`のエージェント処理と`WidgetTicketDO`の顧客向けWebSocket配信 |
| ツール | `search_docs`、`propose_diagnosis`、`propose_draft_reply`、`propose_escalation`、`request_followup_question`、`propose_action` |
| RAG | `support-docs`。URLとPDF/MD/TXT/HTML/CSV/JSON/DOCX/XLSX/PPTXから取り込み |
| プラットフォームエージェント | `support-overview`。未対応チケット・待ち時間・傾向の読み取り専用要約 |
| 画面 | Vite・Reactの管理画面と単一ファイルのウィジェット。サイズは自分のビルドで確認してください |
| 認証 | メール認証とパスワード。最初の利用者をオーナーにし、以降は`app_allowlist`で招待 |

## 日本語と利用手順

管理画面とウィジェットの言語欄で「日本語」を選びます。初期値は英語です。選択をブラウザーに保存し、切り替え時も入力を保持します。ウィジェットは`data-lang="ja"`を初期値にできますが、保存済み選択を優先します。埋め込み先の言語設定は変更しません。

- [基本の導入とユーザー識別](docs/ja/getting-started.md)
- [製品データ・操作の接続](docs/ja/product-integration.md)
- [構成図と環境変数](docs/ja/architecture.md)
- [承認条件・RLS・v1の制約](docs/ja/safety-and-limits.md)
- [リポジトリ構成と開発](docs/ja/development.md)
- [フロントエンド](frontend/README.ja.md)

## 貢献とライセンス

不具合報告・機能提案・PRを受け付けます。まとまった変更では`docs/butterbase/02-plan.md`を更新し、既知の残件を解決した場合は`06-v1-deferred.md`も更新してください。`01-idea.md`の安全に関する制約2・3・9・10を緩める場合は、先に議論してください。

Apache-2.0です。[リポジトリのLICENSE](../../LICENSE)を参照してください。
