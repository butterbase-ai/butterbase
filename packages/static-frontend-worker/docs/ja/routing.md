# リダイレクト・本番デプロイ

[日本語README](../../README.ja.md)

## `_redirects`

`dist/`のzipルートへ`_redirects`を含められます。デプロイ時に`deployment.service.ts`の`deployViaWfp`が`parseRedirects`で読み込み、規則を`BB_REDIRECTS_RULES`のplain_text bindingへ埋め込みます。元ファイルはアップロード対象から除かれ、`/_redirects`は404を返します。静的ファイルの検索前に規則を確認し、最初の一致を使います。

Cloudflare Pagesと互換性のある次の範囲に対応します。

- `#`コメントと空行。
- `<from> <to> [status]`。省略したstatusは`301`。
- `from`末尾の`/*`と、`to`の`:splat`。
- `200`での書き換え（元URLで対象内容を配信）。
- `301`・`302`・`303`・`307`・`308`でのリダイレクト（`Location`ヘッダー）。

名前付き`:id`、query・header条件（`status=200 country=US`）、強制一致`!`には未対応です。

`_redirects`がない場合は静的ファイルを直接検索し、見つからなければ対象パスに応じて`/`へSPAフォールバックします。`BB_*`は予約済みbindingで、デプロイ時に利用者の環境変数を設定した後に追加するため上書きできません。

## パスごとの動作

`html_handling: 'none'`なので、`/index.html`や`/foo.html`は直接200で配信され、`/`や`/foo`への自動リダイレクトはありません。必要なら次の規則を含めます。

```
/index.html / 301
/foo.html   /foo 301
```

`/missing.png`・`/missing.css`・`/missing.js`のような非HTML拡張子でファイルがない場合は404です。拡張子のないパス（`/history`・`/profile/42`）と`.html`・`.htm`は、ファイルがなければトップへSPAフォールバックします。

ただし、先に明示的な`200`書き換えが一致すればその規則を使います。`/* /index.html 200`があれば、`/missing.png`もindex.htmlを200で返します。

## 本番デプロイ

`cloudflare-wfp.ts`の`deployUserWorker`が`WORKER_SOURCE`を`worker.mjs`としてWfP dispatch namespaceへアップロードします。続いて`deployViaWfp`が公開URLのSPA routing probe（PR #36）を実行し、深いパスが200・text/htmlを返さなければ`SPA_ROUTING_PROBE_FAILED`でデプロイを失敗にします。
