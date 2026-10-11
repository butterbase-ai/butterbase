---
title: ファイルストレージ
description: 署名付きURLでファイルを転送し、アプリ・ユーザーごとに分離します。
---

署名付きURLによるファイルストレージを提供します。ファイルはアプリ・ユーザー単位で整理され、フロントエンドから直接アップロード・ダウンロードします。ファイル本体を自分のバックエンドコードに通す必要はありません。

ストレージはアプリと同じ[リージョン](/ja/core-concepts/regions/)にあり、ユーザーに近い場所で転送します。

<span id="how-it-works"></span>

## 仕組み

1. **アップロードURLを取得** — ファイル名、コンテンツ種類、サイズを指定して署名付きURLを要求。
2. **直接アップロード** — フロントエンドから署名付きURLへ送信。
3. **ファイルを参照** — 返された`objectId`をデータベースへ保存（例：`image_url`列）。
4. **必要なときに取得** — objectIdで署名付きダウンロードURLを要求。

<span id="object-id-object-key-and-urls"></span>

## Object ID・オブジェクトキー・URL

| 値 | 内容 | 使い方 |
|--------|------------|---------------------|
| **`objectId`** | ファイルを表す固定UUID | **データベースへ保存**し、取得・削除に使用。 |
| **`objectKey`** | バケット内のパス | **URLではない。** メタデータとして扱い、表示用に保存しない。 |
| **`uploadUrl`／`downloadUrl`** | 一時的な署名付きHTTPS URL | **直後**の操作にだけ使用。**期限あり。** |

:::caution
非公開ファイルの恒久的な公開URLは提供しません。表示・取得する際は、新しい署名付きダウンロードURLを発行してください。
:::

<span id="common-mistakes"></span>

## よくある間違い

- **objectKeyをURLとして保存** — パスなので、画像を表示できません。
- **objectKeyをimg srcに指定** — objectIdでダウンロードAPIを呼び、downloadUrlを取得してください。
- **署名付きURLだけを保存** — 期限切れになります。永続的な参照にはobjectIdを保存してください。

<span id="uploading-a-file"></span>

## アップロード

**手順1：** アップロードURLを取得します。

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

`public: true`を指定すると、全認証済みユーザーが取得できます。[公開ファイル](#public-files)を参照してください。

**レスポンス：**

```json
{
  "uploadUrl": "https://storage.example.com/...",
  "objectKey": "app_id/user_id/uuid_profile.jpg",
  "objectId": "uuid",
  "expiresIn": 300
}
```

**手順2：** 署名付きURLでファイルを送信します。

```javascript
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: fileBlob
});
```

**手順3：** objectIdをデータベースへ保存します。

<span id="downloading-a-file"></span>

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

<span id="showing-images-in-the-ui"></span>

## 画面で画像を表示

objectIdを含む行を取得したら、次の順に処理します。

1. 各ファイルのダウンロードAPI、またはSDKの`getDownloadUrl(objectId)`を呼ぶ。
2. 返されたdownloadUrlを`<img src>`やダウンロードリンクに使う。
3. 一覧では`Promise.all`などで**並列**取得して高速化する。

<span id="listing-files"></span>

## ファイル一覧

```
GET /storage/{app_id}/objects
Authorization: Bearer {token}
```

`id`、`filename`、`content_type`、`size_bytes`、`created_at`を含むオブジェクト配列を返します。

<span id="storage-limits"></span>

## 制限

| 項目 | 既定値 |
|-------|---------|
| 最大ファイルサイズ | 1ファイル10 MB |
| 合計ストレージ | アプリごとに1 GB |
| 許可するコンテンツ種類 | すべて（設定可能） |

<span id="access-control"></span>

## アクセス制御

- **サービスキー：** 全ファイルにアクセス可能。アップロードをユーザーへ紐付けません。
- **エンドユーザー：** 自分のファイルだけを閲覧・管理。認証済みユーザーへ自動で紐付けます。

<span id="public-files"></span>

## 公開ファイル

既定では非公開で、本人またはサービスキー利用者だけがダウンロードURLを取得できます。公開読み取りの設定は2種類ありますが、どちらも認証済みユーザーが対象です。

<span id="per-object-public-true-at-upload-time"></span>

### ファイル単位：アップロード時の`public: true`

アップロード本文に`public: true`を指定します。

```json
{
  "filename": "post-image.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 204800,
  "public": true
}
```

全認証済みユーザーが、アップロードした人によらず`GET /storage/{app_id}/download/{object_id}`を呼べます。

<span id="app-wide-publicreadenabled"></span>

### アプリ全体：`publicReadEnabled`

アプリ設定を切り替えると、認証済みユーザーが**全ファイル**を読めます。

```json
PATCH /v1/{app_id}/config/storage
Authorization: Bearer {token}

{ "publicReadEnabled": true }
```

有効にすると次の動作になります。
- 認証済みユーザーがアプリの全ファイルを取得可能
- アップロード・削除はユーザー単位のままで、自分のファイルだけ管理可能
- ファイル単位のpublic指定は不要

<span id="authorization-summary"></span>

### 許可の条件

認証済みの呼び出しで、次の**いずれか**を満たすとURLを発行します。

1. サービスキー（`bb_sk_...`）で認証。
2. アプリで`publicReadEnabled: true`。
3. ファイルで`public: true`。
4. 認証ユーザーがファイルの所有者。

<span id="url-expiration"></span>

## URLの有効期限

- アップロードURL：**5分**
- ダウンロードURL：**1時間**

<span id="sdk-usage"></span>

## SDKでの利用

```typescript
const { data } = await butterbase.storage.upload(file);
const { data: url } = await butterbase.storage.getDownloadUrl(objectId);
const { data: objects } = await butterbase.storage.list();
await butterbase.storage.delete(objectId);

// Mark a file as publicly downloadable
await butterbase.storage.upload(file, 'avatar.png', { public: true });
```
