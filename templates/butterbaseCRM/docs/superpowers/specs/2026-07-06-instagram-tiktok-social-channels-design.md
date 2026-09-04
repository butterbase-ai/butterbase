# Instagram + TikTok social channels

## Summary

Add Instagram and TikTok as post channels alongside the existing Twitter / LinkedIn / Reddit set. Both are media-first platforms — Instagram requires an image or video, TikTok requires a video — so this change also adds a media pipeline (upload → store → send-time presigned URL) to `social_posts`. Once media exists, images optionally attach to Twitter and LinkedIn too.

Delivery uses the existing Composio-based pattern: `configure-social-toolkit` for BYO OAuth (TikTok) or Composio-managed connect (Instagram), then `sendInstagram` / `sendTiktok` entries in the `SENDERS` map inside `send-social-post`.

## Scope

**In scope**
- New channels `instagram` and `tiktok` across type unions, `VALID_CHANNELS`, `SENDERS`, external-id/url helpers, connection-panel UI, and setup wizard.
- New `media` column on `social_posts` holding an array of storage-object references.
- Media upload UI in `SocialPostComposer` (reuse `bb.storage.upload`).
- Send-time presigned-URL minting inside `send-social-post` for Composio to fetch.
- Storage config bump: `maxFileSizeMb = 250`, `storageLimitBytes = 5 GB` (already applied via MCP smoke).
- Optional image attachment to Twitter (single image) and LinkedIn (single image) as a natural byproduct.

**Instagram post types** (all in scope)
- Feed image, feed video, Reel, Carousel (2–10 images and/or videos), Story (24h auto-expiry).
- Post type is selected per-post via `channel_overrides.instagram.post_type ∈ {'feed', 'reel', 'story', 'carousel'}`. Default inferred from media (single image → feed, single video → feed, ≥2 → carousel; user can override).

**TikTok post types** (all in scope)
- Video (1 clip, ≤250 MB) and Photo (1–35 images). Selected via `channel_overrides.tiktok.post_type ∈ {'video', 'photo'}` (auto-inferred from media kind).

**Twitter & LinkedIn media** (all in scope)
- Twitter: up to 4 images OR 1 video (≤512 MB, ≤2:20) attached to a tweet.
- LinkedIn: 1 image OR 1 video (≤200 MB, ≤10 min) on a UGC post.

**Out of scope**
- Media library / re-usable asset picker (uploads still ephemeral to a single post).
- TikTok privacy / disable-comments / disable-duet controls beyond `PUBLIC_TO_EVERYONE`.
- Scheduling changes — existing `process-scheduled-social-posts` cron handles new channels identically.
- Instagram Reels covers / thumbnails — send whatever the user uploads.
- AI-generated captions or thumbnail extraction.

## Prerequisites (verified)

- Composio toolkits exist: `instagram` (OAUTH2, `requires_byo_credentials: false` — Composio-managed) and `tiktok` (OAUTH2, `requires_byo_credentials: true`). Confirmed via `manage_integrations list_available`.
- Instagram posting requires a **Business** or **Creator** account linked to a Facebook Page (Meta limitation, not ours).
- TikTok requires a **BYO Meta-style** developer app (`client_id` + `client_secret`), same pattern as Twitter/LinkedIn today.
- Storage per-file and total caps are now MCP-configurable. Current app is at 250 MB / 5 GB — sufficient for images, TikTok short clips, and Reels.

## Data model

### `social_posts.media` — new column

```sql
ALTER TABLE social_posts ADD COLUMN media jsonb NOT NULL DEFAULT '[]'::jsonb;
```

Shape: `[{ object_id: string, kind: 'image' | 'video', mime: string, size_bytes: number }]`.

- Ordering preserved (first = primary, matters for carousels in v2).
- `object_id` is the Butterbase storage UUID (not the S3 key). Presigned URLs are minted at send-time.
- Empty array is legal for text-only channels (Twitter / LinkedIn / Reddit) even after this change.
- Migration is additive; existing rows default to `[]`.

### `channel_overrides` — new keys

```ts
channel_overrides.instagram?: {
  caption?: string
  post_type?: 'feed' | 'reel' | 'story' | 'carousel'   // default inferred from media
}
channel_overrides.tiktok?: {
  caption?: string
  title?: string
  post_type?: 'video' | 'photo'                        // default inferred from media
  privacy?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY'
}
channel_overrides.twitter?: {
  body?: string
  // media consumed positionally from post.media (up to 4 images OR 1 video)
}
channel_overrides.linkedin?: {
  body?: string
  visibility?: 'PUBLIC' | 'CONNECTIONS'
  // media consumed positionally from post.media (1 image OR 1 video)
}
```

Effective body per channel is: `channel_overrides[channel]?.caption ?? posts.body` (mirrors existing `eff(body, overrides, channel)` helper).

## Backend changes

### `configure-social-toolkit`

- Add `instagram` to `TOOLKIT_SCOPES` with `[]` (Composio-managed default scopes).
- Add `tiktok` to `TOOLKIT_SCOPES`: `['user.info.basic', 'video.upload', 'video.publish']`.
- Instagram short-circuits the BYO-credentials branch: if `toolkit === 'instagram'`, do **not** require `client_id`/`client_secret`; call upstream `POST /integrations/configure` with just `{ toolkit, scopes, displayName }`.
- TikTok follows the Twitter/LinkedIn/Reddit path (BYO client_id + client_secret required).

### `create-social-post` + `publish-social-post`

- `VALID_CHANNELS`: add `'instagram'`, `'tiktok'`.
- New validations per channel (only enforced on publish, not draft):

**Instagram**, per `post_type`:
| post_type | media count | media kind | notes |
| --- | --- | --- | --- |
| `feed` | 1 | image or video | video ≤ 100 MB, ≤ 60s |
| `reel` | 1 | video | video ≤ 100 MB, ≤ 90s, 9:16 preferred |
| `story` | 1 | image or video | video ≤ 100 MB, ≤ 60s, auto-expires 24h |
| `carousel` | 2–10 | image and/or video | each ≤ 100 MB |

Caption ≤ 2200 across all IG types.

**TikTok**, per `post_type`:
| post_type | media count | media kind |
| --- | --- | --- |
| `video` | 1 | video (≤ 250 MB, ≤ 10 min) |
| `photo` | 1–35 | image |

Caption ≤ 2200.

**Twitter**: `media.length` in 0..4. Either up to 4 images OR exactly 1 video (≤ 512 MB, ≤ 2:20). Body ≤ 280.

**LinkedIn**: `media.length` in 0..1. Image or video. Video ≤ 200 MB, ≤ 10 min. Body ≤ 3000.

**Reddit**: unchanged (no media).

### `send-social-post`

New helper `presignMedia(ctx, media[])` — for each object, call Butterbase's `GET /v1/{app_id}/storage/download/{object_id}` with `BUTTERBASE_API_KEY` and return the `downloadUrl`. Cache within a single send call. Presigned URLs are valid for 1 hour, longer than any single Composio round-trip.

Existing `sendTwitter` and `sendLinkedIn` are updated to optionally attach media (from `post.media`, positionally); text-only calls remain unchanged when `media` is empty. Two new senders (IG, TikTok) branch on `post_type`.

Twitter media flow (per Composio): `TWITTER_MEDIA_UPLOAD` (chunked for video) → collect `media_ids` → pass into `TWITTER_CREATION_OF_A_POST` as `media.media_ids`.

LinkedIn media flow: `LINKEDIN_REGISTER_UPLOAD` → PUT to returned URL (from `presignMedia`) → include the returned asset URN as `media.media` in `LINKEDIN_CREATE_LINKED_IN_POST` (kind=`IMAGE` or `VIDEO`).

Two new senders:

```ts
async function sendInstagram(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'instagram');
  if (!row) return { ok: false, error: 'instagram: workspace has no connected account' };

  const postType = post.channel_overrides?.instagram?.post_type ?? inferInstagramType(post.media);
  const caption = effectiveBody(post, 'instagram');
  const urls = await presignMedia(ctx, post.media);

  let creationId: string;
  if (postType === 'carousel') {
    // Create N child containers, then one carousel container.
    const childIds: string[] = [];
    for (let i = 0; i < post.media.length; i++) {
      const m = post.media[i];
      const r = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', {
        [m.kind === 'video' ? 'video_url' : 'image_url']: urls[i],
        media_type: m.kind === 'video' ? 'VIDEO' : 'IMAGE',
        is_carousel_item: true,
      }, row.user_id);
      if (!r.ok) return r;
      const id = r.data?.id;
      if (m.kind === 'video') await waitForFinished(ctx, row.user_id, id);
      childIds.push(id);
    }
    const parent = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', {
      media_type: 'CAROUSEL', caption, children: childIds,
    }, row.user_id);
    if (!parent.ok) return parent;
    creationId = parent.data?.id;
  } else {
    const m = post.media[0];
    const containerParams: any = { caption };
    if (postType === 'story') containerParams.media_type = 'STORIES';
    else if (postType === 'reel') containerParams.media_type = 'REELS';
    else containerParams.media_type = m.kind === 'video' ? 'VIDEO' : 'IMAGE';
    containerParams[m.kind === 'video' ? 'video_url' : 'image_url'] = urls[0];

    const r = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', containerParams, row.user_id);
    if (!r.ok) return r;
    creationId = r.data?.id;
    if (m.kind === 'video') await waitForFinished(ctx, row.user_id, creationId);
  }

  return composio(ctx, 'INSTAGRAM_PUBLISH_IG_USER_MEDIA', { creation_id: creationId }, row.user_id);
}

async function sendTiktok(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'tiktok');
  if (!row) return { ok: false, error: 'tiktok: workspace has no connected account' };

  const postType = post.channel_overrides?.tiktok?.post_type ?? (post.media[0].kind === 'video' ? 'video' : 'photo');
  const caption = effectiveBody(post, 'tiktok');
  const privacy = post.channel_overrides?.tiktok?.privacy ?? 'PUBLIC_TO_EVERYONE';
  const title = post.channel_overrides?.tiktok?.title ?? '';
  const urls = await presignMedia(ctx, post.media);

  const publish = postType === 'photo'
    ? await composio(ctx, 'TIKTOK_POST_PHOTO', {
        photo_urls: urls,
        post_info: { title, description: caption, privacy_level: privacy },
      }, row.user_id)
    : await composio(ctx, 'TIKTOK_PUBLISH_VIDEO', {
        video_url: urls[0],
        post_info: { title, description: caption, privacy_level: privacy },
      }, row.user_id);

  if (!publish.ok) return publish;
  return pollTiktokStatus(ctx, row.user_id, publish.data?.publish_id, publish);
}
```

Register in `SENDERS`: `{ twitter, linkedin, reddit, instagram: sendInstagram, tiktok: sendTiktok }`.

### External-id / external-url helpers

- `externalIdFor('instagram', data)` → `data?.id` from publish response.
- `externalUrlFor('instagram', data)` → `https://www.instagram.com/p/${shortcode}` if the publish response includes a shortcode, else `null`. (Composio's `INSTAGRAM_PUBLISH_IG_USER_MEDIA` returns the media ID but not the shortcode; may need a follow-up `INSTAGRAM_GET_MEDIA` to resolve shortcode. Cheap — do it inline.)
- `externalIdFor('tiktok', data)` → `data?.publish_id` (during poll) → replaced by `data?.post_id` on FINISHED.
- `externalUrlFor('tiktok', data)` → derived from FINISHED-state response payload (`share_url` field).

### `delete-social-post-from-platform`

- `instagram` (feed / reel / carousel) → `INSTAGRAM_DELETE_MEDIA` with `media_id = external_id`.
- `instagram` **story** — return early with `{ ok: true, note: 'stories auto-expire in 24h' }`; local delete still fires.
- `tiktok` (video / photo) — no public delete API. Return `{ ok: false, error: 'tiktok: platform does not support programmatic delete' }`; UI surfaces this as a passive info banner.

### Env var pre-req

`send-social-post` and `delete-social-post-from-platform` already need `BUTTERBASE_API_KEY` (from prior memory: [[project-social-functions-need-api-key-env]]). No new env vars.

## Frontend changes

### `frontend/src/lib/socialApi.ts`

- `SocialChannel` union: add `'instagram'`, `'tiktok'`.
- Extend `ChannelOverrides` typedef with `instagram?` and `tiktok?` sub-types.

### `SocialPostComposer.tsx`

- `META` map gains: `instagram: { name: 'Instagram', limit: 2200 }`, `tiktok: { name: 'TikTok', limit: 2200 }`.
- New media picker section, always visible: file input accepting `image/*, video/*`, calling `bb.storage.upload`; result stored in local `media: MediaRef[]` state and echoed as a horizontally-scrollable thumbnail row with drag-to-reorder and per-item delete.
- Client-side pre-upload validation: per-channel media count / size caps, prevent obviously-bad uploads before consuming storage.
- Per-channel override panels (only render when channel is selected):
  - **Instagram**: caption textarea + post-type radio (Feed / Reel / Story / Carousel). Radio auto-picks based on `media` shape but user can override where valid.
  - **TikTok**: caption textarea + optional title, post-type radio (Video / Photo) auto-inferred, privacy dropdown.
  - **Twitter**: body override textarea. Media consumed from primary media pool. Warns if media count/kind incompatible with Twitter's rules.
  - **LinkedIn**: body override + visibility dropdown. Uses first media item; warns if extra media will be dropped.
- Channel toggles disabled with tooltip when the current `media` shape is invalid for that channel (e.g. IG toggle disabled with 0 media, TikTok disabled with mixed image+video).

### `SocialConnectionsPanel.tsx` + `SocialSetupWizard.tsx`

- Add two channel rows. Instagram uses the no-credentials connect flow (`connect` action → OAuth redirect, no wizard step for client_id/secret). TikTok uses the same wizard as Twitter/LinkedIn/Reddit.
- `SocialIcons.tsx`: add `InstagramIcon`, `TikTokIcon`.

### `SocialPostDetailPanel.tsx`

- Render new channel results with icon + view-on-platform link.
- If a delete-from-platform call returns the "does not support programmatic delete" error, render a passive info banner ("TikTok posts must be deleted in the TikTok app") rather than a red error.

## Error handling

Behaviors mirror the existing per-channel result shape (`{ send, ok, error?, external_id?, external_url? }`). New failure modes:

| Scenario | Where caught | Surface |
| --- | --- | --- |
| Instagram not linked to a Facebook Page | `sendInstagram` gets `INSTAGRAM_POST_IG_USER_MEDIA` 400 | Per-send `error` string surfaces the platform message |
| Instagram media rejected by Meta (aspect ratio, codec, length) | Composio `error` payload | Same |
| TikTok processing stuck | `pollTiktokStatus` timeout (90s) | `error: 'tiktok: processing timed out — check TikTok inbox'`, external_id populated with `publish_id` for later reconciliation |
| Media object no longer exists (deleted between save and send) | `presignMedia` → 404 | Per-send `error: 'media object missing'` |
| Presigned URL expiry (Composio slow) | 1h TTL — practically impossible on a single-send | N/A |

Retry behavior is unchanged: `Retry failed channels` re-runs `send-social-post` for the failed subset, re-minting fresh presigned URLs each attempt.

## Testing

- **Unit / integration (functions):**
  - `create-social-post`: media validation branches per channel.
  - `send-social-post`: `presignMedia` calls storage endpoint with service key; senders dispatched by channel; failing platforms don't block others.
- **Manual end-to-end:**
  - Connect Instagram Business account → post image → verify appears on IG feed and `external_url` opens the post.
  - Connect Instagram Business account → post video as Reel → verify FINISHED polling reaches success.
  - Connect TikTok (BYO app in TikTok Developer Portal, sandbox mode) → post ≤60s video → verify appears in TikTok drafts (sandbox) or feed (production).
  - Draft with `channels: ['instagram']` but no media → publish → expect 4xx with clear error and dialog inline surface.
- **No new regression risk to existing channels** because the change is additive: senders map unchanged for Twitter/LinkedIn/Reddit, and `media` defaults to `[]`.

## Rollout

1. Apply schema migration (`social_posts.media`).
2. Deploy `configure-social-toolkit` first (needed by wizard).
3. Deploy `create-social-post` + `publish-social-post` (validation).
4. Deploy `send-social-post` + `delete-social-post-from-platform` (dispatch + presign helper).
5. Ship frontend.
6. Update deploy checklist / memory: new channels need workspace-admin Instagram + TikTok connect. TikTok also requires developer app + review submission before non-sandbox posting.

## Non-goals worth naming

- No media library / re-usable asset picker (uploads still ephemeral to one post).
- No AI-generated captions or auto-thumbnails in v1 (the AI social post agent can add this later — orthogonal).

## Open questions

None blocking. Future v2 items: media library across posts, richer TikTok privacy controls, Twitter thread posts, LinkedIn document/PDF posts.
