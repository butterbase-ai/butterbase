function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

// Walk common Composio/upstream error-carrying paths and return the deepest
// user-meaningful string we can find. Composio's outer envelope is often just
// "Error executing the tool <TOOL_NAME>" — the actual reason (rate limit,
// CreditsDepleted, duplicate content, OAuth expired) lives nested under
// data.details / data.error / data.errors[] / errors[].detail. We probe a
// bunch of shapes so we surface the real cause instead of the wrapper.
function extractComposioError(res, toolName) {
  const candidates = [];
  const push = (v) => { if (v != null && v !== '') candidates.push(v); };

  push(res?.data?.details);
  push(res?.data?.error);
  push(res?.data?.errors);
  push(res?.details);
  push(res?.error);
  push(res?.errors);
  push(res?.message);

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c;
    if (Array.isArray(c) && c.length > 0) {
      const first = c[0];
      if (typeof first === 'string') return first;
      const inner = first?.detail ?? first?.message ?? first?.title ?? first?.error ?? first?.reason;
      if (typeof inner === 'string') return inner;
      return JSON.stringify(first).slice(0, 400);
    }
    if (c && typeof c === 'object') {
      const inner = c.detail ?? c.message ?? c.title ?? c.error ?? c.reason;
      if (typeof inner === 'string') return inner;
    }
  }
  return `${toolName}: no upstream error text (raw=${JSON.stringify(res).slice(0, 400)})`;
}

// Canonical integration call: rides on the auto-injected
// BUTTERBASE_FUNCTION_SERVICE_KEY — no BUTTERBASE_API_KEY env var required.
async function composio(ctx, toolName, params, userId) {
  try {
    const res = await ctx.integrations.asUser(userId).execute(toolName, params);

    if (res && res.successful === false) {
      const detail = extractComposioError(res, toolName);
      // Log full raw response once so we can adapt if Composio changes its
      // shape again. Trimmed to keep logs readable.
      console.log(`[composio ${toolName}] failed raw=${JSON.stringify(res).slice(0, 1500)}`);
      return { ok: false, error: String(detail).slice(0, 500) };
    }

    // Composio sometimes returns HTTP 200 with the upstream error embedded in
    // the response body (e.g. X's CreditsDepleted, X's rate limits, Composio's
    // own INTEGRATIONS_EXECUTION_FAILED wrapper). Detect those before we
    // declare success and mark a non-existent post as "sent".
    const errNode = res?.error ?? res?.data?.error ?? res?.data?.errors;
    if (errNode) {
      const detail = extractComposioError(res, toolName);
      console.log(`[composio ${toolName}] embedded-error raw=${JSON.stringify(res).slice(0, 1500)}`);
      return { ok: false, error: String(detail).slice(0, 500) };
    }
    return { ok: true, data: (res && res.data) ?? res ?? {} };
  } catch (e) {
    return { ok: false, error: `integrations: ${e?.message ?? String(e)}` };
  }
}

function effectiveBody(post, channel) {
  const override = post.channel_overrides?.[channel]?.body;
  return (typeof override === 'string' && override.length > 0) ? override : post.body;
}

// Resolve the workspace's shared connection for a toolkit. Any member can have
// performed the OAuth — we just need *some* row so the post executes against
// the workspace-bound account rather than re-prompting each new member.
async function resolveWorkspaceIntegration(ctx, workspaceId, toolkit) {
  const r = await ctx.db.query(
    `SELECT id, user_id, metadata FROM workspace_integrations
      WHERE workspace_id = $1 AND toolkit_slug = $2
      ORDER BY connected_at ASC
      LIMIT 1`,
    [workspaceId, toolkit],
  );
  return r.rows?.[0] ?? null;
}

async function presignMedia(ctx, media) {
  if (!media || media.length === 0) return [];
  const key = ctx.env.BUTTERBASE_API_KEY;
  const appId = ctx.env.BUTTERBASE_APP_ID;
  if (!key || !appId) throw new Error('presignMedia: missing BUTTERBASE_API_KEY or BUTTERBASE_APP_ID');
  const urls = await Promise.all(media.map(async (m) => {
    const r = await fetch(`https://api.butterbase.ai/v1/${appId}/storage/download/${m.object_id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`media object missing: ${m.object_id}`);
    const body = await r.json().catch(() => ({}));
    if (!body.downloadUrl) throw new Error(`media object missing downloadUrl: ${m.object_id}`);
    return body.downloadUrl;
  }));
  return urls;
}

async function waitForFinished(ctx, userId, creationId) {
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await composio(ctx, 'INSTAGRAM_GET_MEDIA', { fields: 'status_code', media_id: creationId }, userId);
    if (!r.ok) return r;
    const status = r.data?.status_code ?? r.data?.data?.status_code ?? deepKey(r.data, ['status_code']);
    if (status === 'FINISHED') return { ok: true };
    if (status === 'ERROR' || status === 'EXPIRED') return { ok: false, error: `instagram: container ${status}` };
  }
  return { ok: false, error: 'instagram: container processing timed out (90s)' };
}

async function pollTiktokStatus(ctx, userId, publishId, initial) {
  if (!publishId) return initial;
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    await new Promise(r => setTimeout(r, 3000));
    const r = await composio(ctx, 'TIKTOK_FETCH_PUBLISH_STATUS', { publish_id: publishId }, userId);
    if (!r.ok) continue;
    const status = r.data?.status ?? deepKey(r.data, ['status']);
    if (status === 'PUBLISH_COMPLETE' || status === 'FINISHED') return { ok: true, data: r.data };
    if (status === 'FAILED' || status === 'PUBLISH_FAILED') {
      return { ok: false, error: `tiktok: publish failed (${r.data?.fail_reason ?? 'unknown'})` };
    }
  }
  return { ok: false, error: 'tiktok: processing timed out — check TikTok inbox', data: { publish_id: publishId } };
}

function inferInstagramType(media) {
  if (media.length >= 2) return 'carousel';
  return 'feed';
}

async function sendTwitter(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'twitter');
  if (!row) return { ok: false, error: 'twitter: workspace has no connected account' };
  const text = effectiveBody(post, 'twitter');
  const userId = row.user_id;
  if (!post.media || post.media.length === 0) {
    return composio(ctx, 'TWITTER_CREATION_OF_A_POST', { text }, userId);
  }
  const urls = await presignMedia(ctx, post.media);
  const mediaIds = [];
  for (let i = 0; i < post.media.length; i++) {
    const m = post.media[i];
    const up = await composio(ctx, 'TWITTER_MEDIA_UPLOAD', {
      media_url: urls[i],
      media_category: m.kind === 'video' ? 'tweet_video' : 'tweet_image',
    }, userId);
    if (!up.ok) return up;
    const id = up.data?.media_id_string ?? up.data?.media_id ?? deepKey(up.data, ['media_id_string', 'media_id']);
    if (!id) return { ok: false, error: 'twitter: media upload returned no id' };
    mediaIds.push(String(id));
  }
  return composio(ctx, 'TWITTER_CREATION_OF_A_POST', { text, media: { media_ids: mediaIds } }, userId);
}

async function sendLinkedIn(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'linkedin');
  if (!row) return { ok: false, error: 'linkedin: workspace has no connected account' };
  const userId = row.user_id;
  let urn = row.metadata?.linkedin_author_urn ?? null;

  if (!urn) {
    const info = await composio(ctx, 'LINKEDIN_GET_MY_INFO', {}, userId);
    if (!info.ok) return info;
    const id = info.data?.id ?? info.data?.sub ?? info.data?.data?.id;
    if (!id) return { ok: false, error: 'linkedin: no author id returned from GET_MY_INFO' };
    urn = `urn:li:person:${id}`;
    await ctx.db.query(
      `UPDATE workspace_integrations
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('linkedin_author_urn', $2::text)
       WHERE id = $1`,
      [row.id, urn],
    );
  }

  const body = effectiveBody(post, 'linkedin');
  const visibility = post.channel_overrides?.linkedin?.visibility ?? 'PUBLIC';

  if (post.media && post.media.length > 0) {
    const m = post.media[0];
    const [mediaUrl] = await presignMedia(ctx, [m]);
    const reg = await composio(ctx, 'LINKEDIN_REGISTER_UPLOAD', {
      owner: urn,
      recipes: [m.kind === 'video' ? 'urn:li:digitalmediaRecipe:feedshare-video' : 'urn:li:digitalmediaRecipe:feedshare-image'],
      serviceRelationships: [{ identifier: 'urn:li:userGeneratedContent', relationshipType: 'OWNER' }],
      supportedUploadMechanism: ['SYNCHRONOUS_UPLOAD'],
    }, userId);
    if (!reg.ok) return reg;
    const asset = reg.data?.asset ?? deepKey(reg.data, ['asset']);
    const uploadUrl = deepUrl(reg.data, 'linkedin.com') ?? deepKey(reg.data, ['uploadUrl']);
    if (!asset || !uploadUrl) return { ok: false, error: 'linkedin: register upload returned no asset/uploadUrl' };
    const file = await fetch(mediaUrl);
    if (!file.ok) return { ok: false, error: `linkedin: fetching presigned media failed: ${file.status}` };
    const put = await fetch(uploadUrl, { method: 'PUT', body: await file.arrayBuffer(), headers: { 'content-type': m.mime || 'application/octet-stream' } });
    if (!put.ok) return { ok: false, error: `linkedin: upload PUT failed: ${put.status}` };
    return composio(ctx, 'LINKEDIN_CREATE_LINKED_IN_POST', {
      author: urn, commentary: body, visibility,
      media: [{ status: 'READY', mediaKind: m.kind === 'video' ? 'VIDEO' : 'IMAGE', asset }],
    }, userId);
  }
  if (post.link_url) {
    return composio(ctx, 'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE', {
      author: urn,
      visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': visibility },
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: { text: body },
          shareMediaCategory: 'ARTICLE',
          media: [{ status: 'READY', originalUrl: post.link_url }],
        },
      },
    }, userId);
  }
  return composio(ctx, 'LINKEDIN_CREATE_LINKED_IN_POST', { author: urn, commentary: body, visibility }, userId);
}

async function sendReddit(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'reddit');
  if (!row) return { ok: false, error: 'reddit: workspace has no connected account' };
  const userId = row.user_id;
  const r = post.channel_overrides?.reddit ?? {};
  if (!r.subreddit || !r.title) {
    return { ok: false, error: 'reddit: missing subreddit or title' };
  }
  const body = effectiveBody(post, 'reddit');
  const kind = post.link_url ? 'link' : 'self';
  const params = {
    subreddit: r.subreddit,
    title: r.title,
    kind,
    ...(kind === 'self' ? { text: body } : { url: post.link_url }),
    ...(r.flair_id ? { flair_id: r.flair_id } : {}),
  };
  const res = await composio(ctx, 'REDDIT_CREATE_REDDIT_POST', params, userId);
  if (!res.ok) return res;
  // Reddit/Composio reply HTTP 200 (successful=true) even when the post was
  // rejected — the real failure shows up as success:false / validation_error
  // on the data object, or an embedded json.errors array. Treat any of these
  // as a failure so we don't mark a non-existent post as "sent".
  const d = res.data ?? {};
  const errs = d?.json?.errors ?? d?.errors;
  if (d.success === false || d.validation_error || (Array.isArray(errs) && errs.length > 0)) {
    const msg = d.validation_message ?? d.validation_error
      ?? (Array.isArray(errs) ? JSON.stringify(errs) : 'reddit rejected the post');
    return { ok: false, error: `reddit: ${String(msg).slice(0, 250)}` };
  }
  return res;
}

async function sendInstagram(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'instagram');
  if (!row) return { ok: false, error: 'instagram: workspace has no connected account' };
  if (!post.media || post.media.length === 0) return { ok: false, error: 'instagram: no media on post' };

  const postType = post.channel_overrides?.instagram?.post_type ?? inferInstagramType(post.media);
  const caption = effectiveBody(post, 'instagram');
  const urls = await presignMedia(ctx, post.media);
  const userId = row.user_id;

  let creationId;
  if (postType === 'carousel') {
    const childIds = [];
    for (let i = 0; i < post.media.length; i++) {
      const m = post.media[i];
      const r = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', {
        [m.kind === 'video' ? 'video_url' : 'image_url']: urls[i],
        media_type: m.kind === 'video' ? 'VIDEO' : 'IMAGE',
        is_carousel_item: true,
      }, userId);
      if (!r.ok) return r;
      const id = r.data?.id ?? deepKey(r.data, ['id']);
      if (!id) return { ok: false, error: 'instagram: carousel child creation returned no id' };
      if (m.kind === 'video') {
        const wait = await waitForFinished(ctx, userId, id);
        if (!wait.ok) return wait;
      }
      childIds.push(id);
    }
    const parent = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', {
      media_type: 'CAROUSEL', caption, children: childIds,
    }, userId);
    if (!parent.ok) return parent;
    creationId = parent.data?.id ?? deepKey(parent.data, ['id']);
  } else {
    const m = post.media[0];
    const params = { caption };
    if (postType === 'story') params.media_type = 'STORIES';
    else if (postType === 'reel') params.media_type = 'REELS';
    else params.media_type = m.kind === 'video' ? 'VIDEO' : 'IMAGE';
    params[m.kind === 'video' ? 'video_url' : 'image_url'] = urls[0];

    const r = await composio(ctx, 'INSTAGRAM_POST_IG_USER_MEDIA', params, userId);
    if (!r.ok) return r;
    creationId = r.data?.id ?? deepKey(r.data, ['id']);
    if (!creationId) return { ok: false, error: 'instagram: creation returned no id' };
    if (m.kind === 'video') {
      const wait = await waitForFinished(ctx, userId, creationId);
      if (!wait.ok) return wait;
    }
  }

  const publish = await composio(ctx, 'INSTAGRAM_PUBLISH_IG_USER_MEDIA', { creation_id: creationId }, userId);
  if (!publish.ok) return publish;

  const publishedId = publish.data?.id ?? deepKey(publish.data, ['id']);
  if (publishedId) {
    const enrich = await composio(ctx, 'INSTAGRAM_GET_MEDIA', { media_id: publishedId, fields: 'id,shortcode,permalink' }, userId);
    if (enrich.ok && enrich.data) {
      publish.data = { ...publish.data, shortcode: enrich.data.shortcode ?? deepKey(enrich.data, ['shortcode']), permalink: enrich.data.permalink ?? deepKey(enrich.data, ['permalink']) };
    }
  }
  return publish;
}

async function sendTiktok(ctx, post, _send) {
  const row = await resolveWorkspaceIntegration(ctx, post.workspace_id, 'tiktok');
  if (!row) return { ok: false, error: 'tiktok: workspace has no connected account' };
  if (!post.media || post.media.length === 0) return { ok: false, error: 'tiktok: no media on post' };

  const overrides = post.channel_overrides?.tiktok ?? {};
  const postType = overrides.post_type ?? (post.media[0].kind === 'video' ? 'video' : 'photo');
  const caption = effectiveBody(post, 'tiktok');
  const privacy = overrides.privacy ?? 'PUBLIC_TO_EVERYONE';
  const title = overrides.title ?? '';
  const urls = await presignMedia(ctx, post.media);
  const userId = row.user_id;

  const publish = postType === 'photo'
    ? await composio(ctx, 'TIKTOK_POST_PHOTO', {
        photo_urls: urls,
        post_info: { title, description: caption, privacy_level: privacy },
      }, userId)
    : await composio(ctx, 'TIKTOK_PUBLISH_VIDEO', {
        video_url: urls[0],
        post_info: { title, description: caption, privacy_level: privacy },
      }, userId);

  if (!publish.ok) return publish;
  const publishId = publish.data?.publish_id ?? deepKey(publish.data, ['publish_id']);
  return pollTiktokStatus(ctx, userId, publishId, publish);
}

const SENDERS = {
  twitter: sendTwitter, linkedin: sendLinkedIn, reddit: sendReddit,
  instagram: sendInstagram, tiktok: sendTiktok,
};

// Composio wraps provider responses inconsistently (under data / response_dict /
// json.data / etc.), so dig defensively rather than assume one fixed shape.
function deepKey(node, keys, depth = 0) {
  if (node == null || typeof node !== 'object' || depth > 6) return null;
  for (const k of keys) if (typeof node[k] === 'string' && node[k]) return node[k];
  for (const v of Object.values(node)) {
    const f = deepKey(v, keys, depth + 1);
    if (f) return f;
  }
  return null;
}

function deepUrl(node, needle, depth = 0) {
  if (node == null || depth > 6) return null;
  if (typeof node === 'string') return (node.startsWith('http') && node.includes(needle)) ? node : null;
  if (typeof node !== 'object') return null;
  for (const v of Object.values(node)) {
    const f = deepUrl(v, needle, depth + 1);
    if (f) return f;
  }
  return null;
}

function externalIdFor(channel, data) {
  if (channel === 'twitter') return data?.id ?? data?.data?.id ?? deepKey(data, ['id']) ?? null;
  if (channel === 'linkedin') {
    // LinkedIn's create-post returns the share URN under `x_restli_id`; older/wrapped
    // shapes use id/activity/ugcPostUrn/shareUrn. Check all.
    return data?.x_restli_id ?? data?.id ?? data?.data?.id ?? data?.response_dict?.id ?? data?.activity
      ?? deepKey(data, ['x_restli_id', 'id', 'activity', 'ugcPostUrn', 'shareUrn']) ?? null;
  }
  if (channel === 'reddit') {
    return data?.json?.data?.name ?? data?.name ?? data?.data?.name ?? deepKey(data, ['name']) ?? null;
  }
  if (channel === 'instagram') {
    return data?.id ?? data?.data?.id ?? deepKey(data, ['id']) ?? null;
  }
  if (channel === 'tiktok') {
    return data?.post_id ?? data?.publish_id ?? deepKey(data, ['post_id', 'publish_id']) ?? null;
  }
  return null;
}

function externalUrlFor(channel, data) {
  if (channel === 'twitter') {
    const id = externalIdFor('twitter', data);
    return id ? `https://twitter.com/i/web/status/${id}` : null;
  }
  if (channel === 'linkedin') {
    const id = externalIdFor('linkedin', data);
    if (!id) return null;
    const urn = id.startsWith('urn:') ? id : `urn:li:share:${id}`;
    return `https://www.linkedin.com/feed/update/${urn}`;
  }
  if (channel === 'reddit') {
    return data?.json?.data?.url ?? data?.url ?? data?.data?.url ?? deepUrl(data, 'reddit.com') ?? null;
  }
  if (channel === 'instagram') {
    const permalink = data?.permalink ?? deepKey(data, ['permalink']);
    if (permalink) return permalink;
    const sc = data?.shortcode ?? deepKey(data, ['shortcode']);
    return sc ? `https://www.instagram.com/p/${sc}` : null;
  }
  if (channel === 'tiktok') {
    return data?.share_url ?? deepKey(data, ['share_url']) ?? null;
  }
  return null;
}

export async function handler(req, ctx) {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { post_id, retry = false } = body || {};
  if (!post_id) return json(400, { error: 'missing post_id' });

  const postRow = await ctx.db.query(`SELECT * FROM social_posts WHERE id = $1`, [post_id]);
  const post = postRow.rows?.[0];
  if (!post) return json(404, { error: 'post_not_found' });

  if (!['sending', 'scheduled'].includes(post.status) && !retry) {
    return json(200, { ok: true, noop: true, status: post.status });
  }

  if (retry) {
    await ctx.db.query(
      `UPDATE social_post_sends
          SET status='pending', attempts = attempts + 1, error = NULL
        WHERE post_id = $1 AND status = 'failed'`,
      [post_id],
    );
  }

  await ctx.db.query(
    `UPDATE social_posts SET status='sending', updated_at=now() WHERE id=$1`,
    [post_id],
  );

  const pendingRes = await ctx.db.query(
    `SELECT * FROM social_post_sends WHERE post_id = $1 AND status = 'pending'`,
    [post_id],
  );
  const pending = pendingRes.rows ?? [];

  const results = await Promise.all(pending.map(async (send) => {
    const sender = SENDERS[send.channel];
    if (!sender) return { send, ok: false, error: `unknown channel: ${send.channel}` };
    try {
      const r = await sender(ctx, post, send);
      return { send, ...r };
    } catch (e) {
      return { send, ok: false, error: `exception: ${e?.message ?? String(e)}` };
    }
  }));

  for (const r of results) {
    console.log(`[send-social-post] ${r.send.channel} ok=${r.ok} ${JSON.stringify(r.ok ? r.data : r.error)?.slice(0, 1500)}`);
    if (r.ok) {
      await ctx.db.query(
        `UPDATE social_post_sends
            SET status='sent', external_post_id=$2, external_url=$3, sent_at=now()
          WHERE id=$1`,
        [r.send.id, externalIdFor(r.send.channel, r.data), externalUrlFor(r.send.channel, r.data)],
      );
    } else {
      await ctx.db.query(
        `UPDATE social_post_sends SET status='failed', error=$2 WHERE id=$1`,
        [r.send.id, (r.error ?? 'unknown_error').slice(0, 1000)],
      );
    }
  }

  const allRes = await ctx.db.query(`SELECT status FROM social_post_sends WHERE post_id = $1`, [post_id]);
  const all = (allRes.rows ?? []).map(r => r.status);
  const allSent = all.length > 0 && all.every(s => s === 'sent');
  const noneSent = all.every(s => s !== 'sent');
  const finalStatus = allSent ? 'sent' : noneSent ? 'failed' : 'partial';

  await ctx.db.query(
    `UPDATE social_posts
        SET status=$2,
            published_at = CASE WHEN $2 IN ('sent','partial') AND published_at IS NULL THEN now() ELSE published_at END,
            updated_at=now()
      WHERE id=$1`,
    [post_id, finalStatus],
  );

  const activityKind = finalStatus === 'failed' ? 'social_post_failed' : 'social_post_published';
  const channelStatuses = Object.fromEntries(results.map(r => [r.send.channel, r.ok ? 'sent' : 'failed']));
  await ctx.db.query(
    `INSERT INTO activities (workspace_id, actor_user_id, kind, entity_type, entity_id, payload)
     VALUES ($1, $2, $3, 'social_post', $4, $5::jsonb)`,
    [
      post.workspace_id,
      post.created_by,
      activityKind,
      post_id,
      JSON.stringify({ channels: channelStatuses, body_preview: post.body.slice(0, 140) }),
    ],
  );

  return json(200, {
    ok: true,
    status: finalStatus,
    results: results.map(r => ({ channel: r.send.channel, ok: r.ok, error: r.error })),
  });
}

