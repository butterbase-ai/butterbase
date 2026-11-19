# コードのスナップショット同期

[クイックスタート](../../QUICKSTART.ja.md) · [英語の原文](../../QUICKSTART.md#9-syncing-code-with-the-butterbase-repo)

アプリごとに、内容のハッシュで管理するコードリポジトリがあります。プロジェクトの状態を変更不能なスナップショットとして保存し、shaで識別します。複製先のコード取得と`repo pull`・`repo push`に使います。

```
your laptop                    Butterbase platform
─────────────                  ─────────────────────
working tree  ── push ────►    snapshot 8034d485…  (latest)
              ◄── pull ────                snapshot c887118…
                              .butterbase/config.json.pinned_snapshot_id
                                       points at one of these
```

## pull

複製直後、チームメンバーの変更を取得するとき、プラットフォームの状態へ戻すときに使います。

```bash
butterbase repo pull                       # latest snapshot for the bound app
butterbase repo pull --snapshot <sha>      # a specific historical snapshot
butterbase repo pull --app <app_id>        # override the bound app
```

現在のフォルダーへ書き込み、`.butterbaseignore`を適用します。除外した`node_modules/`や`.env*`などは変更しません。

## push

自分の作業を正本のスナップショットにするとき、共有するとき、復元点を作るときに使います。

```bash
butterbase repo push --message "short summary"   # required: a commit-style message
butterbase repo push --dry-run                   # show the manifest without uploading
butterbase repo push --json                      # machine-readable output
```

プラットフォームにない内容だけを追加する増分方式です。200ファイル中の1件を変更した場合は、概ね1件を送ります。成功すると新しいスナップショットIDを表示します。

## 除外ルール

`.butterbaseignore`が除外対象の正本です。`node_modules/`・`dist/`・`.next/`・`.turbo/`・`.DS_Store`・`.butterbase/`は既定で除外します。追加したいものは1行1パターンで記録します。

  ```
  # .butterbaseignore
  .playwright-mcp/
  frontend/frontend.zip
  frontend/.env.local
  ```

原文では`.env`・`.env.local`は既定で除外されないため、明示的なパターンが必要と説明しています。使用するCLIの除外設定も確認してください。

  ```
  .env
  .env.local
  .env.*.local
  ```

## 固定したスナップショットと最新状態

`.butterbase/config.json`の`pinned_snapshot_id`で、取得対象を固定できます。固定は任意です。チームメンバーが新しいコードを送っても、意図せず更新するのを避けます。

```bash
butterbase repo status                     # shows pinned_snapshot_id, remote_latest_snapshot_id, file_count
butterbase repo list-snapshots             # full history newest-first
```

pull後に固定先を進める場合です。

```bash
butterbase repo pin --latest               # or `butterbase repo pin <sha>`
```

コードのpushと関数の配置は別工程です。`repo push`だけでは`enrich-company`や`agent-chat`を再配置しません。関数を変更したら、MCP・CLIで`deploy_function`も行います。
