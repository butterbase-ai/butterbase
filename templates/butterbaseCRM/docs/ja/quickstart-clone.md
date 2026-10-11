# 複製後の設定

[クイックスタート](../../QUICKSTART.ja.md) · [英語の原文](../../QUICKSTART.md#5-path-b--you-cloned-the-butterbase-app)

複製はスキーマ・RLS・関数・ストレージ・realtime・AI設定・toolkitの一覧をコピーします。シークレットと利用者の外部アカウント接続は持ち越しません。

## 関数の環境変数

関数は`ctx.env`を読みます。複製先で変数を設定しないと、AI利用・自己呼び出しでURL未設定や認証エラーになります。

| 変数 | 設定する値 |
|---|---|
| `BUTTERBASE_API_URL` | `https://api.butterbase.ai` |
| `BUTTERBASE_APP_ID` | 自分の新しい`app_<id>`。元アプリのIDを使わない |
| `BUTTERBASE_API_KEY` | 複製先で発行したサービスキー |
| `BUTTERBASE_FRONTEND_URL` | `invite-member`で招待リンクを作るための、自分の画面のURL |

`enrich-company`・`enrich-person`に外部のAPIキーは不要です。上記のButterbase設定からAI gatewayとPeople APIを使います。`discover-comment-targets`・`run-comment-discovery`には`AI_SERVICE_KEY`、`notetaker-webhook`には`NOTETAKER_WEBHOOK_SECRET`が必要です。Webhookの初回登録は[既知の制約](../known-limitations.md)を参照してください。

原文のMCP例です。必要な関数ごとに設定するか、対応する環境ではアプリの既定スコープへ設定します。

```bash
# Via MCP (in Claude Code / any MCP client)
manage_function set_env --name summarize-company --env '{"BUTTERBASE_API_URL":"https://api.butterbase.ai","BUTTERBASE_APP_ID":"app_xyz123","BUTTERBASE_API_KEY":"bb_..."}'

# …repeat per function, or set them at app-default scope if your dashboard supports it.
```

## Google OAuth

複製先にはプロバイダーの一覧だけを持ち越します。元アプリのクライアントID・シークレット・redirect URIを使い回さないでください。

メール・パスワードだけで運用するなら`manage_auth_config`でGoogleを無効にします。Googleを使うなら、自分のOAuthクライアントを作り、`manage_oauth configure`へID・シークレット・対象アプリのredirect URIを設定します。登録URIは対象アプリの認証設定が返す値へ合わせてください。元アプリの例は[バックエンドREADME](../../backend/README.ja.md)にあります。

## 外部アカウントとsubstrate

Gmail・カレンダーなどのtoolkit一覧はコピーしますが、利用者の接続はコピーしません。各メンバーがアプリ内で自分のアカウントを接続します。Composioの認証情報を変更する場合を除き、アプリオーナーの追加操作は不要です。

`ctx.substrate`を使う場合は、複製先を管理画面から自分のsubstrateユーザーへ接続します。原文では任意の手順ですが、substrateを使うCRMの機能には接続が必要です。

## フロントエンド

```bash
# frontend/.env.local
VITE_BUTTERBASE_APP_ID=app_xyz123                              # your new id
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
```

## 初回確認

順に確認し、失敗した段階を直してから次へ進みます。

1. `manage_app get --app_id app_xyz123`で複製したアプリを取得。
2. `select_rows --table workspaces --limit 1`がエラーなく`[]`を返す。
3. 画面から登録し、ワークスペースを作成。
4. `invoke_function --name summarize-company --body '{"company_id":"<id>"}'`で、環境変数とAI接続を確認。
5. 招待メールを送って、画面URLとGmail連携を確認。
