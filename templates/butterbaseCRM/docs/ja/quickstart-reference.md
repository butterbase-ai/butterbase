# 作業例・構成・問題の切り分け

[クイックスタート](../../QUICKSTART.ja.md) · [英語の原文](../../QUICKSTART.md#95-typical-workflows)

## 作業例

1人・1台での開発です。

```bash
# edit code…
butterbase repo push --message "what I changed"
```

複製したアプリのコードを取得して開発します。

```bash
butterbase init                            # bind the folder to the app
butterbase repo pull                       # populate the working tree
cd frontend && npm install
npm run dev                                # iterate
butterbase repo push --message "..."       # ship changes
```

同じアプリで2人が協力する場合です。

```bash
# Teammate A
butterbase repo push --message "added meeting brief tool"

# Teammate B
butterbase repo pull                       # picks up A's changes
# …make further edits…
butterbase repo push --message "follow-up tweaks"
```

## 構成の要点

- Postgres：原文時点で29テーブル。基本CRMエンティティはsubstrateにあります。ワークスペースのRLSは`memberships`を使い、ミラーのポリシーは19テーブル分です。
- 認証：メール・パスワードとGoogle OAuth。SDKが各要求へJWTを付けます。
- Realtime：17テーブルをWebSocketで購読し、関連するReact Queryキャッシュを無効にします。
- ストレージ：署名付きURLのアップロード。原文の上限は10 MBです。
- 関数：原文時点で56のHTTP・cron関数。要約、招待、Google同期、AI検索・補完、配信、リード検索、会議、SNSを扱います。
- AI：原文はButterbase gateway経由のClaude Haiku 4.5です。画面にAIのサービスキーは不要です。
- substrate：会社・連絡先などをエンティティとして扱い、アプリ間の識別に使います。

## 問題の切り分け

| 症状 | 確認すること |
|---|---|
| 全要求で`401 Unauthorized` | セッションの期限と`VITE_BUTTERBASE_API_URL`。ログアウト・再ログインし`.env.local`を確認 |
| ログインできても一覧が空 | 所属する`memberships`がない可能性。ワークスペースを作ると最初のオーナーになる |
| build後のpreviewが空白 | `VITE_*`はビルド時に必要。ビルド前に`.env.local`を用意 |
| Realtimeが更新しない | DevToolsのNetwork → WSで接続を確認。`RealtimeBoot`へJWTが届いているか調べる |
| sync.shでキー未設定 | キーを`backend/`ではなくルートの`.env`かシェルへ設定 |
| 複製先の関数でURL未設定の500 | 関数の`BUTTERBASE_API_URL`・`BUTTERBASE_APP_ID`・`BUTTERBASE_API_KEY` |
| 招待リンクがlocalhostや無効なURL | `invite-member`の`BUTTERBASE_FRONTEND_URL` |
| Googleでループ・`redirect_uri_mismatch` | 複製先専用のOAuthクライアントと登録URI。使わないならGoogleを無効にする |
| 複製先のAIが401 | 未設定のキーか元アプリのキー。複製先で新しいキーを発行して設定 |

設計の背景は[02-plan.md](../butterbase/02-plan.md)、詳細は[バックエンドREADME](../../backend/README.ja.md)を参照してください。
