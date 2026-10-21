---
title: カスタムドメイン
description: 独自ホスト名でフロントエンドを公開し、SSLを自動管理します。
---

全フロントエンドに無料の`*.pages.dev` URLを割り当てます。**カスタムドメイン**を設定すると、自分の`app.example.com`やルートの`example.com`でも配信でき、SSL証明書はButterbaseが発行・更新します。

**Launch以上**のプランで利用できます。

<span id="how-it-works"></span>

## 仕組み

Cloudflare for SaaSを使い、ホスト名追加時に次を行います。

1. Cloudflareのcustom hostnameとして登録し、アプリへ紐付け。
2. エッジが対象アプリを特定できるKV対応表を作成。
3. DNSを指定先へ向け、所有権を検証。
4. Cloudflareが証明書を発行し、自動で更新。

DNSの管理は自分で続けられます。ドメインをCloudflareへ移す必要はありません。

<span id="requirements"></span>

## 必要条件

| 条件 | 理由 |
|---|---|
| Launch以上のプラン | `custom_domain`機能で制御。Playgroundは`403`。 |
| アプリがドメインを所有 | ホスト名は全体で一意。同じ名前を別アプリが追加すると`409`。 |
| 公開済みフロントエンド | アプリの現在の配信先へ接続。ドメインだけ先に追加も可能だが、配信内容はまだない。 |
| WfPのデプロイ基盤 | 旧基盤では`400`。新規アプリはWfP。 |
| DNS設定の権限 | CNAMEとTXTを作成できること。 |

<span id="step-1--pick-a-validation-method"></span>

## 手順1 — 検証方法を選択

`validation_method`は証明書発行前の所有権確認方法です。選択の誤りはpendingが続く主な原因になります。

| 方法 | 仕組み | 適する場合 | 避ける場合 |
|---|---|---|---|
| `http`（既定） | Cloudflareが検証ファイルを配信。必要なのは接続用CNAMEだけ。 | サブドメイン、Cloudflare以外のDNS。 | Cloudflareの**プロキシ有効**ゾーンや**Cloudflare上のルートドメイン**。プロキシが検証を妨げ、CNAME flatteningでレコードも見えなくなる。 |
| `txt` | Cloudflareが返すTXTをDNSへ追加。 | Cloudflareのルートドメイン、プロキシ有効ゾーン、確実な方法を選びたい場合。 | — |

目安は、**一般のDNS上のサブドメインならhttp、Cloudflare上またはルートドメインならtxt**です。

<span id="step-2--add-the-domain"></span>

## 手順2 — ドメインを追加

**ダッシュボード：App → Settings → Custom domains → Add domain**。

**CLI:**

```bash
butterbase domains add app.example.com
butterbase domains add example.com --validation-method txt
```

**REST API:**

```
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{ "hostname": "app.example.com", "validation_method": "http" }
```

**MCP:**

```
manage_frontend({
  app_id: "app_abc123",
  action: "configure_custom_domain",
  domain_action: "add",
  hostname: "app.example.com"
})
```

`201`レスポンスには次の手順に必要な情報が入ります。

```json
{
  "domain": { "id": "…", "hostname": "app.example.com", "status": "pending", "ssl_status": "pending" },
  "cname_target": "butterbase.dev",
  "validation_method": "http",
  "verification_records": [{ "txt_name": "_acme-challenge.app.example.com", "txt_value": "…" }],
  "ownership_verification": null,
  "instructions": "Add a CNAME record at your DNS provider: …"
}
```

状態確認・再検証・削除で使うdomain.idを保存してください。

<span id="step-3--add-your-dns-records"></span>

## 手順3 — DNSを設定

<span id="if-you-chose-http"></span>

### httpの場合

1つのレコードを追加します。

| 種類 | 名前 | 値 |
|---|---|---|
| CNAME | `app.example.com` | `butterbase.dev` |

:::caution
**Cloudflare DNSではDNS-only（灰色の雲）を指定してください。** 別Cloudflareアカウントへのプロキシ有効CNAME（オレンジの雲）は**Error 1014**になり動作しません。
:::

<span id="if-you-chose-txt"></span>

### txtの場合

2つ、場合によって3つのレコードを追加します。

| # | 種類 | 名前 | 値 |
|---|---|---|---|
| 1 | CNAME | `app.example.com` | `butterbase.dev` — ルートではプロバイダー対応の形式を使用（Cloudflareのflattened CNAMEも可） |
| 2 | TXT | `verification_records[].txt_name` | `verification_records[].txt_value` — 証明書を認可 |
| 3 | TXT | `ownership_verification.name` | `ownership_verification.value` — Cloudflareプロキシのゾーン**だけ**で返る。返された場合は追加 |

verification_recordsが空なら、まだCloudflareが生成していません。1分後に状態APIを呼んでください。

<span id="step-4--watch-it-go-active"></span>

## 手順4 — 有効化を確認

```bash
butterbase domains status <domain-id>
```

```
GET /v1/{app_id}/custom-domains/{domain_id}/status
```

毎回Cloudflareの状態を読み直して保存するため、現在の状態を返します。

```json
{
  "domain": {
    "hostname": "app.example.com",
    "status": "active",
    "ssl_status": "active",
    "verification_errors": null
  },
  "cname_target": "butterbase.dev",
  "verification_records": [],
  "ownership_verification": null
}
```

| フィールド | 意味 |
|---|---|
| `status` | ホスト名の状態。pendingはDNS・検証待ち、activeは配信可能。 |
| `ssl_status` | 証明書の状態。pending／initializing／pending_validationは発行中、activeはHTTPS利用可能。 |
| `verification_errors` | 検証拒否の理由。進まない場合はまず確認。 |

**statusとssl_statusがともにactiveになると公開完了**です。通常5〜15分で、DNS反映が時間の多くを占めます。

止まっている場合、ドメインを再作成せず検証を再実行できます。元のvalidation_methodは保持します。

```bash
butterbase domains verify <domain-id>
```

```
POST /v1/{app_id}/custom-domains/{domain_id}/verify
```

<span id="apex-vs-www"></span>

## ルートドメインとwww

Butterbaseは両者を強制リダイレクトしません。どちらも通常のホスト名で、正規URLにできます。

- 正規URLを決め、そのドメインを追加します。
- 他方はDNSプロバイダーのエッジで転送します（Cloudflare Redirect Rules、Netlify／Vercel、レジストラーのALIASとルールなど）。
- Cloudflareのルートは`validation_method: "txt"`が必要です。他社のCNAME flattening対応DNSならhttpも使えます。
- flattening非対応ならwww.example.comを設定し、ルートから転送します。

<span id="managing-domains"></span>

## ドメイン管理

| メソッド | パス | MCP domain_action | 用途 |
|--------|------|---------------------|---------|
| POST | `/v1/{app_id}/custom-domains` | `add` | ホスト名を追加（validation_method指定可） |
| GET | `/v1/{app_id}/custom-domains` | `list` | アプリの全ホスト名を取得 |
| GET | `/v1/{app_id}/custom-domains/{id}/status` | `status` | 現在の検証・SSL状態 |
| POST | `/v1/{app_id}/custom-domains/{id}/verify` | `verify` | 再検証 |
| DELETE | `/v1/{app_id}/custom-domains/{id}` | `remove` | ホスト名を削除 |

```bash
butterbase domains list
butterbase domains add <hostname> [--validation-method http|txt]
butterbase domains status <domain-id>
butterbase domains verify <domain-id>
butterbase domains delete <domain-id> [--yes]
```

```typescript
await bb.admin.domains.list();
await bb.admin.domains.add('app.example.com', 'txt');
await bb.admin.domains.getStatus(domainId);
await bb.admin.domains.verify(domainId);
await bb.admin.domains.remove(domainId);
```

:::caution
削除するとそのホスト名への配信を即座に停止します。DNSを別の宛先へ変えるまで、訪問者にはエラーを表示します。
:::

<span id="troubleshooting"></span>

## 問題の対処

| 症状 | 原因 | 対処 |
|---|---|---|
| 追加時403 | 組織のプランにcustom_domainがない | [プランと使用量](/ja/core-concepts/plans-and-usage/)から更新 |
| 409 already registered | 同じアプリか別アプリが登録済み | 同じアプリなら状態確認。別なら名前を変更 |
| 基盤について400 | 旧デプロイ基盤 | 先にWfPへ移行 |
| 503 Cloudflare is not configured | セルフホストで認証情報が未設定 | Control APIのCloudflare設定を確認 |
| ブラウザのError 1014 | アカウントをまたぐプロキシCNAME | DNS-onlyへ変更 |
| ルートでpendingが続く | Cloudflareのゾーンでhttpを使用 | 削除してtxtで再登録 |
| statusはactive、ssl_statusが進まない | TXT検証レコードが不正か欠落 | 状態APIのverification_recordsで修正しverify |
| 古いサイトが表示 | 再公開後のエッジキャッシュ | 数分待ち、強制再読み込み。[デプロイ](/ja/core-concepts/frontend-deployment/)を参照 |

<span id="related"></span>

## 関連ページ

- [フロントエンドのデプロイ](/ja/core-concepts/frontend-deployment/) — 公開の基本
- [エッジSSR](/ja/core-concepts/edge-ssr-deployment/) — サーバーレンダリング
- [プランと使用量](/ja/core-concepts/plans-and-usage/) — 対応プラン
- 複製先にはカスタムドメインを引き継ぎません。[複製先の設定](/ja/templates/configure/)を参照
