# アプリの運用

[日本語READMEに戻る](../../README.ja.md)

### アプリのサーバー設定

```bash
butterbase apps config get
butterbase apps config cors --allowed-origin https://app.example --allow-credentials true
butterbase apps config jwt --access-token-ttl 15m --refresh-token-ttl-days 30
butterbase apps config storage --public-read true --max-file-size-mb 25 --allowed-content-type image/png --allowed-content-type image/jpeg
butterbase apps config access-mode authenticated
butterbase apps config secure --table posts --table comments --user-column author_id --access-mode authenticated
```


### リージョンとアプリの移行

```bash
butterbase regions list
butterbase apps move app_abc us-west-2 --follow
butterbase apps migrations active                 # current app
butterbase apps migrations status app_abc m_xyz
butterbase apps migrations abort app_abc m_xyz     # before cutover
butterbase apps migrations reverse app_abc m_xyz   # after cutover
butterbase apps replicas list
butterbase apps replicas teardown m_xyz
```


### アプリの課金（Stripe Connect）

```bash
butterbase app-billing plans list
butterbase app-billing plans create --name pro --price-cents 1999 --interval month
butterbase app-billing plans update plan_abc --price-cents 2499
butterbase app-billing products list
butterbase app-billing products create --name "Lifetime access" --price-cents 9900
butterbase app-billing subscribe plan_abc
butterbase app-billing subscription
butterbase app-billing cancel
butterbase app-billing purchase prod_xyz
butterbase app-billing orders list
butterbase app-billing orders get order_abc
```


### 範囲を限定したAPIキーと外部連携

```bash
butterbase keys generate ci-key --scope app --app app_abc123 --extra-scope ai:gateway   # --scope: account (default) | app
butterbase keys list
butterbase keys revoke <key-id>
butterbase integrations configure github --scope repo --scope read:user
butterbase integrations connect github --redirect-url https://app.example/cb --scope repo
```


### 関数のデプロイ（詳細オプション）

```bash
butterbase functions deploy fn.ts \
  --name my-fn \
  --trigger cron --trigger-config '{"schedule":"*/5 * * * *"}' \
  --env API_KEY=sk_... --env DEBUG=true \
  --timeout-ms 9000 --memory-mb 256
```


### RLS

```bash
butterbase rls create --table posts --policy-name posts_own \
  --command SELECT --using "author_id = auth.uid()" \
  --role user --restrictive
butterbase rls delete posts                 # delete all policies on table
butterbase rls delete posts --policy posts_own
```


### その他のコマンド

ほかにも次のコマンドを使えます。オプションは `butterbase <command> --help --lang ja` で確認してください。

- `init [template]`, `clone`, `templates`, `visibility <mode>`, `status`, `open`
- `deploy [directory]`（フロントエンド。`--from-source` でサーバー側ビルド）、`deploy:edge-ssr`、`domains`、`env`
- `data query|insert`、`realtime enable|config|disable`、`kv`、`rag`、`do`（Durable Objects）
- `agents list|get|create|update|delete`, `substrate`, `people`, `partners`, `preview`, `repo`
- `billing`（プラットフォームの課金）、`mcp install`、`plugin setup`
- `apps pause|resume`, `functions get|delete|invoke|env|metrics`, `rls list|enable`, `ai meetings`
