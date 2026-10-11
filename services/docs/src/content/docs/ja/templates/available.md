---
title: 公開テンプレート一覧
description: 現在複製できるButterbaseテンプレートを紹介します。
---

公式テンプレートを2つ公開しています。どちらもデモではなく、Butterbase自身が使う実用アプリです。

![Butterbaseダッシュボードのテンプレート一覧。公式テンプレート2種を表示](/img/templates/templates-browser.png)

<span id="the-catalog"></span>

## カタログ

| テンプレート | 内容 | 関数数 | 複製数 | リージョン | 必要な設定 |
|---|---|---|---|---|---|
| **[Butterbase CRM](/ja/templates/butterbase-crm/)** | AI対応CRM：連絡先、企業、商談、Gmail・Calendar同期、会議記録、キャンペーン、SNS投稿、リード検索 | 56 | 33 | `us-east-1` | **不要。** 環境変数は複製時にすべて自動設定。 |
| **[Butter Support](/ja/templates/butter-support/)** | AIサポートデスク：埋め込みウィジェット、文書RAG、人の承認を伴う返信作成、エスカレーション、ポリシー学習 | 30 | 19 | `us-east-1` | 関数用キー2個、Durable Object用キー6個 |

最新の一覧はいつでも取得できます。

```bash
butterbase templates --sort popular
```

```
manage_app action: "find_templates", sort: "popular"
```

または[ダッシュボード](https://dashboard.butterbase.ai)の**Templates**を開きます。

:::note
誰でもカタログに追加できます。リポジトリのスナップショットをpush済みの公開アプリは複製可能で、`listed: true`を設定すると一覧に表示されます。[テンプレートの公開](/ja/templates/publishing/)を参照してください。
:::

<span id="picking-one"></span>

## 選び方

**Butterbase CRMが向く用途**は、営業CRM、投資家管理、採用選考、提携管理など、人や組織を継続して追うアプリです。機能は多いものの、起動に外部シークレットが不要なため導入しやすい構成です。

**Butter Supportが向く用途**は、サポート窓口、社内ヘルプデスク、文書アシスタント、トリアージなど、自社コンテンツをもとにAIが回答し、人が送信前に承認するアプリです。RAG、Durable Objects、承認付きエージェントの実装例になります。

**用途が大きく違う場合**は、どちらも使わず[クイックスタート](/ja/getting-started/quickstart/)から小さく作る方法もあります。両テンプレートは設計方針が明確で、不要な関数を40個削除するより速い場合があります。

<span id="what-both-give-you"></span>

## 共通で含まれるもの

- スキーマと行レベルセキュリティを適用済みのデータベース
- cronのバックグラウンド処理を含む、多数のデプロイ済み関数
- アプリのユーザーモデルを備えた認証
- 初回の応答にキー設定を要しないAIゲートウェイ連携
- ローカルへpullして編集できるリポジトリのスナップショット
- セッションをまたぐエージェントの記憶に使えるSubstrate連携

<span id="before-you-clone-either"></span>

## 複製前に確認すること

どちらも**大規模**です。スキーマ、RLS、Durable Objects、関数、設定、リポジトリ、シードデータを順に再作成するため、複製は瞬時には終わりません。56個の関数の再デプロイには時間がかかります。秒ではなく分単位を見込み、ジョブをポーリングしてください。

複製先はプランのプロジェクト上限に1アプリとして数えます。Playgroundは合計1プロジェクトなので、既存アプリがない状態で始めるか、先に[アップグレード](/ja/core-concepts/plans-and-usage/)してください。
