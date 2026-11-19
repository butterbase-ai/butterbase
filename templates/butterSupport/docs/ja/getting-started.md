# Butter Supportの導入

[日本語README](../../README.ja.md) · [英語の原文](../../README.md#quickstart-commodity-tier--60-seconds)

## 基本構成

1. テンプレートギャラリー、MCP、CLIのいずれかでアプリを複製します。必要な関数には複製時にサービスAPIキーを発行します。

   ```
   butterbase clone <this_app_id> ./my-support
   cd my-support
   ```

2. 複製後に案内される`https://<your-new-subdomain>.butterbase.dev`を開き、メール認証でログインします。認証後のフックが最初の利用者を`owner`にします。
3. 設定ガイドでヘルプセンターのURLを登録します。文書を取得して`support-docs`へ取り込みます。
4. 製品のHTMLへウィジェットを追加します。

   ```html
   <script async src="https://<your-subdomain>.butterbase.dev/widget.js" data-app-id="<your_clone_app_id>"></script>
   ```

5. SlackまたはGmailをComposio経由で接続し、引き継ぎ先を選びます。テストの問い合わせを送り、文書検索・返信下書き・承認後の送信を確認します。

## ログイン済みユーザーの識別

ウィジェットは匿名の`visitor_token`をサイト側の`localStorage`に保存します。サーバー側コードなしで利用できます。ログイン後に名前やメールを付ける場合は、次を呼び出します。

```html
<script>
  window.ButterSupport = window.ButterSupport || { q: [] };
  window.ButterSupport.q.push(['identify', { user_id: '...', email: '...', name: '...' }]);
</script>
```

この情報はホストページから受け取る自己申告で、署名を検証しません。`open()`・`close()`・`toggle()`・`reset()`も使えます。ログアウト時は`reset()`を呼んでください。

読み込み前は`window.ButterSupport.q`へ操作を追加できます。バンドルのマウント後に順に実行します。

## 言語

埋め込みタグに`data-lang="ja"`を追加すると、保存済み選択がない場合の初期表示を日本語にできます。利用者がEnglishへ切り替えたら、以降はその選択を優先します。ホストページの`html lang`は変更しません。

## 旧ウィジェットシークレット

`widget_secrets`と管理者向け`rotate-widget-secret`は残っていますが、現行の関数・Durable Objectsはそれを読まず、ウィジェット要求の署名も検証しません。`widget-ingest`は`auth: none`で、訪問者トークンの形式を検証します。旧設計の残存コードとして扱い、現在のウィジェット用に回転・使用する必要はありません。
