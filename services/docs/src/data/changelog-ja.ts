export const changelogJa: Record<string, { title: string; description: string }> = {
  "Magic Link Authentication": {
    "title": "マジックリンク認証",
    "description": "アプリのユーザーがパスワードなしでサインインできます。既存の認証フローへ組み込めます。"
  },
  "Preview deployments": {
    "title": "プレビューデプロイ",
    "description": "テーブル、関数、登録済みアカウント、アップロード済みファイルなど実データを含むアプリ全体をコピーし、本番に影響せず試せます。シークレットの値は引き継がず、キー名だけ空の値で作成します。接続アカウント、定期ジョブ、連携は無効になり、コピーしたジョブが誤って動くのを防ぎます。preview secretsでテスト値を設定してください。準備ができたら、テーブル、アクセスルール、関数、Durable Objects、設定、コードを本番へ反映し、フロントエンドを公開できます。データは反映せず、本番データを失う変更は対象を明示して拒否します。意図した変更なら自分で実行してください。resetで本番から再作成できます。Launch以上のプランでアプリごとに1つ、本番と同じリージョンに作成します。manage_preview、promote_preview、REST API、ダッシュボードのPreviewページから操作できます。"
  },
  "App-level environment variables": {
    "title": "アプリ共通の環境変数",
    "description": "アプリで一度設定した環境変数を、全関数がctx.env.<KEY>で参照できます。Stripeを使う各関数にSTRIPE_SECRETを重複登録する必要はありません。同名の場合は関数固有の値が優先され、BUTTERBASE_*のプラットフォーム値が最優先です。共通キーを変えると次の呼び出しから全関数へ適用します。App SettingsのEnvironment variables、manage_appのget_env／update_env、PATCH /v1/:appId/envで管理できます。保存時に暗号化し、読み取りAPIは値を返しません。BUTTERBASE_*は予約済みで設定できません。"
  },
  "ctx.invoke for same-app function-to-function calls": {
    "title": "ctx.invokeによる同一アプリ内の関数呼び出し",
    "description": "ctx.invoke('fn-name', body)で同じアプリの別関数を呼べます。Bearerや環境変数の設定は不要です。ユーザーコードに渡さないアプリ内部キーで認証し、ctx.user.idを呼び出し先へ自動で引き継ぎます。循環呼び出しは深さ4までで、5回目に同期的にエラーになります。Bearer ctx.env.BUTTERBASE_API_KEYを使うHTTP呼び出しを置き換えられます。また、ctx.app.substrateUserIdで紐付くSubstrateユーザーIDを取得でき、未接続の場合はnullです。if (ctx.substrate)を接続状態の判定に使う必要がなくなります。"
  },
  "ctx.caller — validated caller identity": {
    "title": "ctx.callerで検証済みの呼び出し元を取得",
    "description": "全関数でctx.caller = { type, keyId, scope, userId }を参照できます。typeはservice_key、end_user_jwt、loopback、anonymousのいずれかです。keyIdはシークレットではないAPIキー行IDで、監査ログへ記録できます。userIdは代理実行の対象ユーザーで、ctx.invokeやX-Butterbase-As-Userによる呼び出しに引き継ぎます。Authorizationヘッダーを手動で解析する必要はありません。"
  },
  "Service-key impersonation gate": {
    "title": "サービスキーの代理実行を制御",
    "description": "アプリに限定したサービスキーは、X-Butterbase-As-Userヘッダーで指定ユーザーの代理実行ができます。ランタイムは呼び出し前にctx.user.idを設定します。関数ごとのallow_service_key_impersonation（既定値true）で無効にすると、管理専用関数や課金Webhookへの該当ヘッダーをエッジで403拒否します。エンドユーザーJWTと別アプリのサービスキーでは代理実行できません。deploy_function、manage_functionのupdate_settings、CLIのbb functions deploy --no-allow-impersonation、SDKのapiClient.updateFunctionSettings、ダッシュボードの関数詳細で設定できます。"
  },
  "Cloned apps now mint one shared API key": {
    "title": "複製アプリのAPIキーを1つに統一",
    "description": "以前は複製先の関数ごとに別のbb_sk_*キーを自動発行していたため、同一アプリの別関数が自分のctx.env.BUTTERBASE_API_KEYとBearerを比較すると401になりました。現在はアプリごとに1つ発行し、BUTTERBASE_API_KEYまたはBB_SUBSTRATE_KEYを必要とする全関数に設定します。既存の複製アプリはscripts/backfill-consolidate-clone-keys.tsで統一できます。"
  },
  "Agents": {
    "title": "エージェント",
    "description": "LLMノード、ツールノード、接続、制限からなるグラフで複数段階のLLMエージェントを定義します。状態のチェックポイント、SSE／WebSocketストリーミング、冪等性、書き込みツールの人による承認、IP／ユーザー／アプリ単位のレート制限に対応します。ダッシュボード、CLIのbutterbase agents、MCP、RESTで作成できます。"
  },
  "Functions as agent tools": {
    "title": "関数をエージェントのツールとして公開",
    "description": "関数にagent_tool: trueを指定し、説明、read_only／read_writeの実行モード、developer_only／end_userの公開範囲を設定します。エージェントは関数を直接呼び、書き込みツールは変更前に停止して人の承認を求めます。"
  },
  "Multi-trigger functions": {
    "title": "複数トリガーを持つ関数",
    "description": "1つの関数でHTTPと日次cron、S3アップロードとWebhookなど複数のトリガーを宣言できます。http、cron、websocketに加え、s3_uploadとwebhookを追加しました。ダッシュボードで種類ごとに追加・削除できます。"
  },
  "App Templates": {
    "title": "アプリテンプレート",
    "description": "アプリを公開して他のユーザーが複製できるようになりました。スキーマ、RLSポリシー、関数コード、シークレット以外の設定、リポジトリのファイル、シード指定行をコピーします。ダッシュボード、CLIのbutterbase clone、MCPで検索、複製、複製Webhookの設定ができます。"
  },
  "App repo": {
    "title": "アプリのリポジトリ",
    "description": "アプリごとの履歴付きファイル保存機能です。butterbase repo pushでソースを送り、butterbase repo pullで取得し、スナップショット履歴を確認できます。テンプレートの基盤となり、アプリのソースを継続して保存します。"
  },
  "Substrate": {
    "title": "Substrate",
    "description": "AIエージェントのために組織の知識を記録します。エンティティ、決定、約束、学び、原則をアカウントごとの台帳へ保存し、承認・却下、注意ルール、リアルタイム更新、ダッシュボードの閲覧に対応します。SDK、MCP、REST、bb substrateから利用できます。"
  },
  "Key-Value Store": {
    "title": "Key-Valueストア",
    "description": "リージョン単位のKV基盤をSDK、REST、CLI、MCPから利用できます。セッション、ロック、レート制限、冪等性キー、機能フラグのコピーして使える実装例を用意しました。"
  },
  "Durable Object env vars": {
    "title": "Durable Objectの環境変数",
    "description": "butterbase do env set/list/unsetで暗号化した設定をDurable Objectsへ渡せます。アプリ内のDOクラスからenv.KEYで参照します。"
  },
  "Server-Side Build": {
    "title": "サーバー側ビルド",
    "description": "ソースを送ると、Butterbaseがコンテナ内でnpm installとフレームワークのビルドを実行します。ローカルの@cloudflare/next-on-pagesツールチェーンが不要になり、特にWindowsで使いやすくなります。"
  },
  "Durable Objects": {
    "title": "Durable Objects",
    "description": "ストレージとWebSocketを備える、キーごとに状態を持つ実行単位です。チャットルーム、対戦ゲーム、レート制限、長時間動作するAIエージェントを作れます。インフラを自分で運用する必要はありません。"
  },
  "Edge SSR for Next.js & Remix": {
    "title": "Next.jsとRemixのエッジSSR",
    "description": "Next.jsのApp Router、Server Actions、RSCとRemixのサーバーレンダリングをCloudflare Workersへ直接デプロイできます。CLIの1コマンドで公開でき、Node.jsホストの運用は不要です。"
  },
  "Partner API Proxy": {
    "title": "パートナーAPIプロキシ",
    "description": "APIキーを公開せずにアプリから外部APIを呼べます。Butterbaseがキープール、ローテーション、フェイルオーバーを管理し、フロントエンドは1つのプロキシ経路へアクセスします。"
  },
  "Partners SDK, CLI & MCP Support": {
    "title": "パートナーAPIのSDK・CLI・MCP対応",
    "description": "TypeScript SDKのPartnersClient、CLIのbutterbase partners list／partners curl、MCPのlist_partner_apisでパートナーAPIを探して呼び出せます。"
  },
  "Hackathon Submissions & Scoring": {
    "title": "ハッカソンの提出と採点",
    "description": "非同期審査に対応した公開提出APIです。デモURLとプラットフォーム機能の利用状況を採点します。ランキングと再採点のエンドポイントも含みます。"
  },
  "Multimodal Chat Completions": {
    "title": "マルチモーダルのチャット補完",
    "description": "チャット補完リクエストでテキストと一緒に画像を送れます。AI設定APIがマルチモーダルのメッセージ内容に対応しました。"
  },
  "Performance Improvements": {
    "title": "パフォーマンスの改善",
    "description": "認証、クォータ判定、APIキー検証の応答を高速化しました。アプリの変更は不要です。"
  },
  "Custom Domains": {
    "title": "カスタムドメイン",
    "description": "アプリごとに独自ドメインを設定でき、HTTPSを自動で用意します。"
  },
  "Post-Auth Hooks": {
    "title": "認証後のフック",
    "description": "サインイン後に独自の処理を実行し、データの用意、外部システムへの同期、案内メール送信などができます。"
  },
  "Function Logs with Console Capture": {
    "title": "console出力を含む関数ログ",
    "description": "呼び出しごとの標準出力、標準エラー、実行時間をダッシュボードで確認できます。"
  },
  "Function Environment Variables": {
    "title": "関数の環境変数",
    "description": "関数ごとのシークレットと設定を保存時に暗号化し、デプロイ時に読み込み直します。"
  },
  "Native RAG": {
    "title": "組み込みRAG",
    "description": "PDF、DOCX、TXTなどを取り込み、2回のAPI呼び出しで自然言語検索できます。ベクトル検索を内蔵しています。"
  },
  "Third-Party Integrations": {
    "title": "外部サービスとの連携",
    "description": "関数から認証管理済みの外部サービスを呼べるコネクターを用意しました。"
  },
  "Foreign-Key Referential Actions": {
    "title": "外部キーの参照アクション",
    "description": "スキーマでON DELETEとON UPDATEの動作を直接宣言できます。"
  },
  "Per-App Audit Log": {
    "title": "アプリごとの監査ログ",
    "description": "全アプリイベントを共通の活動ログへ記録し、検索できます。"
  },
  "Plan Quotas + Limit Notifications": {
    "title": "プランのクォータと上限通知",
    "description": "プランごとの利用量を計測し、80%と上限到達時にメールで通知します。"
  },
  "App Overview Dashboard": {
    "title": "アプリ概要ダッシュボード",
    "description": "稼働状態、クォータ使用量、前週からの増減、最近の活動をまとめて確認できます。"
  },
  "Edge Frontend Hosting": {
    "title": "エッジでのフロントエンド配信",
    "description": "1回のツール呼び出しでReact、Next.js、静的フロントエンドをグローバルURLへ公開します。SPAのルーティングとHTTPSも処理します。"
  },
  "Cross-Region Realtime": {
    "title": "リージョンをまたぐリアルタイム通知",
    "description": "WebSocketでデータ変更を通知し、RLSに基づくフィルタリング、プレゼンス、自作イベントトリガーに対応します。"
  },
  "Butterbase Skills": {
    "title": "Butterbase Skills",
    "description": "Claude Code用のAIコーディングスキル6種を用意しました。claude plugin add @butterbase/skillsで導入し、build-app、schema-design、function-dev、debug-rls、deploy-frontend、contributingを利用できます。"
  },
  "TypeScript SDK": {
    "title": "TypeScript SDK",
    "description": "@butterbase/sdkが全APIと型付きレスポンスに対応します。"
  },
  "Command-Line Interface": {
    "title": "コマンドラインインターフェース",
    "description": "@butterbase/cliに初期化、連携、プロジェクト管理のコマンドを用意しました。"
  },
  "MCP Server": {
    "title": "MCPサーバー",
    "description": "Claude、Cursor、WindsurfなどのAIアシスタントをMCPでButterbaseへ接続できます。予測しやすい応答、構造化エラー、次の操作の案内を備えたツールを利用できます。"
  },
  "Serverless Functions": {
    "title": "サーバーレス関数",
    "description": "管理されたDenoランタイムへTypeScript／JavaScript関数をデプロイします。HTTPトリガーとcronスケジュールに対応します。"
  },
  "Row-Level Security": {
    "title": "行レベルセキュリティ",
    "description": "1回のツール呼び出しで行へのアクセスを制限し、サインインした各ユーザーが自分のデータだけにアクセスするよう設定できます。"
  },
  "Isolated Postgres per App": {
    "title": "アプリごとに分離したPostgres",
    "description": "各アプリに専用のPostgresデータベース、識別子、APIベースURLを用意します。"
  },
  "Managed Authentication": {
    "title": "管理された認証",
    "description": "メール・パスワード、任意のOAuthプロバイダー、パスワードリセット、メール検証、レート制限をアプリごとに設定できます。"
  },
  "File Storage": {
    "title": "ファイルストレージ",
    "description": "署名付きURLを使うS3互換ストレージです。アプリ・ユーザーごとの整理、サイズとコンテンツ種類の上限、RLSに基づくアクセス制御に対応します。"
  },
  "Declarative Schema + Auto-API": {
    "title": "宣言的スキーマと自動API",
    "description": "JSONでテーブルを定義すると、差分を計算して適用します。HTTPのCRUD APIも自動で提供し、コード生成や手動の経路設定は不要です。"
  },
  "Foundations": {
    "title": "基盤機能",
    "description": "Control API、アプリのプロビジョニング、APIキー管理、プラットフォームの土台を用意しました。"
  }
};
