# 開発予定

[English](./ROADMAP.md) · 日本語

ButterbaseはApache-2.0で公開しています。この予定はプロジェクトの方向を示すもので、実施を約束するものではありません。コミュニティからの意見に応じて優先順位を変えます。

## 意見を寄せる場所

- 機能の提案：[Feature request](https://github.com/butterbase-ai/butterbase/issues/new?template=feature.yml)
- 質問・作ったものの紹介：[Discussions](https://github.com/butterbase-ai/butterbase/discussions)
- バグの報告：[Bug report](https://github.com/butterbase-ai/butterbase/issues/new?template=bug.yml)

## 進行中

- `docker compose -f docker-compose.local.yml up` で動くセルフホスト環境を安定させる。
- 公開SDKとCLIを整え、`@butterbase/*` としてnpmへ公開する。
- スキーマDSL、RLS、サーバーレス関数、デプロイの文書を充実させる。

## 次に検討すること

- pgvector、postgis、pg_cronなどのPostgres拡張を扱いやすくする。
- S3互換以外のストレージを差し替えられるようにする。
- 共通仕様からPython、GoなどのSDKを生成する。
- OpenTelemetryのトレースや構造化ログなど、実運用向けの観測機能を提供する。

## 将来に向けて意見を募集すること

- セルフホストでもクラウド版と対応するcron・キューの機能。
- セルフホスト向けの複数リージョン複製の手順。
- 独自MCPツールを追加するプラグイン・拡張のマーケットプレイス。

関心のある機能や不足している項目があれば、DiscussionまたはIssueへ投稿してください。次に取り組む内容を決める際、コミュニティの意見を重視します。
