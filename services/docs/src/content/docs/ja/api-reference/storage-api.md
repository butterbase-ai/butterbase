---
title: ストレージAPI
description: ファイルストレージのエンドポイント一覧。
sidebar:
  order: 3
---

<span id="endpoints"></span>

## エンドポイント

| メソッド | パス | 用途 |
|--------|------|---------|
| POST | /storage/\{app_id}/upload | 署名付きアップロードURLを取得 |
| GET | /storage/\{app_id}/objects | アプリの全ファイルを一覧取得 |
| GET | /storage/\{app_id}/download/\{object_id} | 署名付きダウンロードURLを取得 |
| DELETE | /storage/\{app_id}/\{object_id} | ファイルを削除 |

<span id="upload"></span>

## アップロード

```json
POST /storage/{app_id}/upload
Authorization: Bearer {token}

{
  "filename": "profile.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 102400,
  "public": false
}
```

`public: true`を指定すると、アップロードした本人以外の認証済みユーザーもダウンロードできます。[公開ファイル](/ja/core-concepts/storage#public-files)を参照してください。

**レスポンス：**

```json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
```

続けてファイルをアップロードします。

```javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
```

<span id="download"></span>

## ダウンロード

```json
GET /storage/{app_id}/download/{object_id}
Authorization: Bearer {token}
```

**レスポンス：**

```json
{
  "downloadUrl": "https://storage.example.com/...",
  "filename": "profile.jpg",
  "expiresIn": 3600
}
```

<span id="list-files"></span>

## ファイル一覧

```
GET /storage/{app_id}/objects
Authorization: Bearer {token}
```

`{ id, filename, content_type, size_bytes, created_at }`の配列を返します。

<span id="url-expiration"></span>

## URLの有効期限

| URLの種類 | 有効期限 |
|----------|-----------|
| アップロード | 5分 |
| ダウンロード | 1時間 |

<span id="storage-limits"></span>

## ストレージの制限

| 項目 | 既定値 |
|-------|---------|
| ファイルの最大サイズ | 10 MB |
| 合計ストレージ | アプリごとに1 GB |
| コンテンツ種類 | すべて（設定可能） |

<span id="access-control"></span>

## アクセス制御

| 認証 | アクセス範囲 |
|------|--------|
| サービスキー | 全ファイル。ユーザーへの紐付けなし |
| エンドユーザーJWT | 自分のファイルのみ。自動で紐付け |

<span id="app-wide-storage-configuration"></span>

## アプリ全体のストレージ設定

| メソッド | パス | 用途 |
|--------|------|---------|
| PATCH | /v1/\{app_id}/config/storage | アプリ全体の公開読み取りを切り替え |

```json
PATCH /v1/{app_id}/config/storage
Authorization: Bearer {token}

{ "publicReadEnabled": true }
```

**レスポンス：**

```json
{
  "message": "Storage configuration updated successfully",
  "app_id": "app_abc123",
  "storage_config": {
    "maxFileSizeMb": 10,
    "allowedContentTypes": ["*/*"],
    "publicReadEnabled": true
  }
}
```

`publicReadEnabled`が`true`の場合、全認証済みユーザーがアプリ内の全ファイルをダウンロードできます。アップロードと削除は引き続きユーザー単位です。
