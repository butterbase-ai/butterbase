---
title: フロントエンドAPI
description: フロントエンドのデプロイ用エンドポイント一覧。
sidebar:
  order: 5
---

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/frontend/deployments | デプロイを作成 |
| POST | /v1/\{app_id}/frontend/deployments/\{id}/start | デプロイを開始 |
| GET | /v1/\{app_id}/frontend/deployments | デプロイ履歴を取得 |
| GET | /v1/\{app_id}/frontend/deployments/\{id} | デプロイ詳細を取得 |
| POST | /v1/\{app_id}/frontend/deployments/\{id}/sync | 状態を強制同期 |
| POST | /v1/\{app_id}/frontend/deployments/\{id}/cancel | デプロイを中止 |
| DELETE | /v1/\{app_id}/frontend/deployments/\{id} | デプロイを削除 |
| PUT | /v1/\{app_id}/frontend/env | 環境変数を設定 |
| GET | /v1/\{app_id}/frontend/env | 環境変数名を一覧取得 |

<span id="create-deployment"></span>

## デプロイの作成

```json
POST /v1/{app_id}/frontend/deployments
Authorization: Bearer {token}

{
  "framework": "react-vite"
}
```

**レスポンス：**

```json
{
  "id": "deployment-uuid",
  "uploadUrl": "https://...",
  "expiresIn": 900,
  "maxSizeBytes": 104857600
}
```

<span id="framework-values"></span>

### フレームワークの値

| フレームワーク | 値 |
|-----------|-------|
| React (Vite) | `react-vite` |
| Next.js（静的） | `nextjs-static` |
| 静的HTML | `static` |
| その他 | `other` |

<span id="upload-and-start"></span>

## アップロードと開始

**zipをアップロード：**

```bash
curl -X PUT "{uploadUrl}" \
  -H "Content-Type: application/zip" \
  --data-binary @frontend.zip
```

**デプロイを開始：**

```
POST /v1/{app_id}/frontend/deployments/{id}/start
```

<span id="deployment-statuses"></span>

## デプロイの状態

| ステータス | 意味 |
|--------|---------|
| `WAITING` | 作成済み。アップロード待ち |
| `UPLOADING` | 処理中 |
| `BUILDING` | ビルド中 |
| `READY` | 成功 |
| `ERROR` | 失敗 |
| `CANCELED` | 中止 |

<span id="environment-variables"></span>

## 環境変数

```json
PUT /v1/{app_id}/frontend/env

{
  "VITE_API_URL": "https://api.butterbase.ai/v1/app_abc123",
  "NEXT_PUBLIC_API_KEY": "pk_test_123"
}
```

値は保存時に暗号化します。一覧ではキー名だけを返します。

<span id="limits"></span>

## 制限

| 項目 | 値 |
|-------|-------|
| 最大サイズ | 100 MB（圧縮後） |
| アップロードの有効期限 | 15分 |
| Freeプラン | 有効なデプロイ1件 |
| Proプラン | 無制限 |

<span id="custom-domains"></span>

## カスタムドメイン

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /v1/\{app_id}/custom-domains | カスタムドメインを追加 |
| GET | /v1/\{app_id}/custom-domains | 一覧取得 |
| GET | /v1/\{app_id}/custom-domains/\{id}/status | 検証状態を確認 |
| POST | /v1/\{app_id}/custom-domains/\{id}/verify | 再検証 |
| DELETE | /v1/\{app_id}/custom-domains/\{id} | カスタムドメインを削除 |

<span id="add-custom-domain"></span>

### カスタムドメインを追加

```json
POST /v1/{app_id}/custom-domains
Authorization: Bearer {token}

{
  "hostname": "app.example.com"
}
```

**レスポンス：**

```json
{
  "domain": {
    "id": "uuid",
    "hostname": "app.example.com",
    "status": "pending",
    "ssl_status": "pending"
  },
  "cname_target": "butterbase.dev",
  "instructions": "Add a CNAME record..."
}
```

レスポンスの`instructions`に、DNSプロバイダー向けのCNAME設定手順が入ります。Cloudflare管理のDNSでは、**DNS-only（灰色の雲）**にしてください。異なるCloudflareアカウント間でプロキシを有効にしたCNAME（オレンジの雲）はError 1014になり、動作しません。

<span id="check-status"></span>

### 状態確認

```
GET /v1/{app_id}/custom-domains/{id}/status
```

Cloudflareの検証状態とSSL状態を返します。ドメイン追加後にポーリングしてください。通常5〜15分で反映します。

<span id="errors"></span>

### エラー

| エラー | 意味 |
|-------|---------|
| `feature_not_available` | プランにカスタムドメインがない（Proへの更新が必要） |
| `RESOURCE_ALREADY_EXISTS` | ホスト名が登録済み |
| `RESOURCE_NOT_FOUND` | ドメインIDが見つからない |
