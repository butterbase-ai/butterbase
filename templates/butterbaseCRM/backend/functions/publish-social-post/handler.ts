function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const LIMITS = {
  twitter: { body: 280 },
  linkedin: { body: 3000 },
  reddit: { title: 300, body: 40000 },
  instagram: { body: 2200 },
  tiktok: { body: 2200 },
};

const VALID_CHANNELS = ['twitter', 'linkedin', 'reddit', 'instagram', 'tiktok'];
const PUBLISHABLE = ['draft', 'scheduled', 'canceled'];

function eff(body, overrides, channel) {
  const o = overrides?.[channel]?.body;
  return (typeof o === 'string' && o.length > 0) ? o : body;
}

const MB = 1024 * 1024;

function inferInstagramType(media) {
  if (media.length >= 2) return 'carousel';
  if (media.length === 1 && media[0].kind === 'video') return 'feed';
  return 'feed';
}

function validateMediaShape(media) {
  if (!Array.isArray(media)) return 'media must be an array';
  for (const m of media) {
    if (!m || typeof m.object_id !== 'string') return 'media entry missing object_id';
    if (m.kind !== 'image' && m.kind !== 'video') return `media kind must be image|video (got ${m.kind})`;
    if (typeof m.size_bytes !== 'number' || m.size_bytes <= 0) return 'media entry missing size_bytes';
  }
  return null;
}

function validateChannel(channel, post) {
  const { body, media, channel_overrides = {} } = post;
  const override = channel_overrides[channel] ?? {};
  const bodyLen = (override.caption ?? override.body ?? body ?? '').length;

  if (channel === 'twitter') {
    if (bodyLen > LIMITS.twitter.body) return 'twitter body exceeds 280 chars';
    const hasVideo = media.some(m => m.kind === 'video');
    const images = media.filter(m => m.kind === 'image').length;
    if (hasVideo && media.length !== 1) return 'twitter: video posts must have exactly 1 video';
    if (!hasVideo && images > 4) return 'twitter: up to 4 images per post';
    if (hasVideo && media[0].size_bytes > 512 * MB) return 'twitter: video exceeds 512 MB';
    return null;
  }
  if (channel === 'linkedin') {
    if (bodyLen > LIMITS.linkedin.body) return 'linkedin body exceeds 3000 chars';
    if (media.length > 1) return 'linkedin: max 1 media item';
    if (media.length === 1 && media[0].kind === 'video' && media[0].size_bytes > 200 * MB) return 'linkedin: video exceeds 200 MB';
    return null;
  }
  if (channel === 'reddit') {
    const r = channel_overrides.reddit ?? {};
    if (!r.title || typeof r.title !== 'string') return 'reddit requires title';
    if (!r.subreddit || typeof r.subreddit !== 'string') return 'reddit requires subreddit';
    if (r.title.length > LIMITS.reddit.title) return 'reddit title exceeds 300 chars';
    if (bodyLen > LIMITS.reddit.body) return 'reddit body exceeds 40000 chars';
    return null;
  }
  if (channel === 'instagram') {
    if (media.length === 0) return 'instagram: requires media';
    if (bodyLen > LIMITS.instagram.body) return 'instagram caption exceeds 2200 chars';
    const postType = override.post_type ?? inferInstagramType(media);
    if (!['feed', 'reel', 'story', 'carousel'].includes(postType)) return `instagram: invalid post_type ${postType}`;
    if (postType === 'carousel') {
      if (media.length < 2 || media.length > 10) return 'instagram carousel: 2–10 media required';
    } else {
      if (media.length !== 1) return `instagram ${postType}: exactly 1 media required`;
    }
    if (postType === 'reel' && media[0].kind !== 'video') return 'instagram reel: video required';
    for (const m of media) {
      if (m.kind === 'video' && m.size_bytes > 100 * MB) return 'instagram: video exceeds 100 MB';
    }
    return null;
  }
  if (channel === 'tiktok') {
    if (media.length === 0) return 'tiktok: requires media';
    if (bodyLen > LIMITS.tiktok.body) return 'tiktok caption exceeds 2200 chars';
    const postType = override.post_type ?? (media[0].kind === 'video' ? 'video' : 'photo');
    if (postType === 'video') {
      if (media.length !== 1 || media[0].kind !== 'video') return 'tiktok video: exactly 1 video required';
      if (media[0].size_bytes > 250 * MB) return 'tiktok: video exceeds 250 MB';
    } else {
      if (media.length < 1 || media.length > 35) return 'tiktok photo: 1–35 images required';
      if (media.some(m => m.kind !== 'image')) return 'tiktok photo: all media must be images';
    }
    return null;
  }
  return null;
}

// Turn a draft/scheduled/canceled post into a live send. Validates connectivity
// and per-channel rules, (re)creates pending send rows, then either schedules
// (cron picks it up) or dispatches send-social-post immediately.
export async function handler(req, ctx) {
  if (!ctx.user) return json(401, { error: 'unauthorized' });

  let input;
  try { input = await req.json(); } catch { return json(400, { error: 'invalid_json' }); }
  const { post_id, scheduled_at } = input || {};
  if (!post_id) return json(400, { error: 'missing post_id' });

  const postRes = await ctx.db.query(`SELECT * FROM social_posts WHERE id = $1`, [post_id]);
  const post = postRes.rows?.[0];
  if (!post) return json(404, { error: 'post_not_found' });

  const memRes = await ctx.db.query(
    `SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [post.workspace_id, ctx.user.id],
  );
  if (!memRes.rows?.[0]) return json(403, { error: 'not_a_member' });

  if (!PUBLISHABLE.includes(post.status)) {
    return json(409, { error: `cannot publish a post with status '${post.status}' — clone it instead` });
  }

  const channels = post.channels ?? [];
  const overrides = post.channel_overrides ?? {};
  if (!Array.isArray(channels) || channels.length === 0) return json(400, { error: 'no channels selected' });
  for (const c of channels) {
    if (!VALID_CHANNELS.includes(c)) return json(400, { error: `invalid channel: ${c}` });
  }

  // Per-channel validation.
  const validationPost = {
    body: post.body,
    media: post.media ?? [],
    channel_overrides: overrides,
  };
  for (const channel of channels) {
    const err = validateChannel(channel, validationPost);
    if (err) return json(400, { error: err });
  }

  // Channels must be connected for this workspace.
  const connRes = await ctx.db.query(
    `SELECT DISTINCT toolkit_slug FROM workspace_integrations WHERE workspace_id = $1 AND toolkit_slug = ANY($2::text[])`,
    [post.workspace_id, channels],
  );
  const connected = new Set((connRes.rows ?? []).map(r => r.toolkit_slug));
  const missing = channels.filter(c => !connected.has(c));
  if (missing.length > 0) return json(400, { error: 'channels_not_connected', missing_channels: missing });

  // Scheduling.
  let isScheduled = false;
  const sched = scheduled_at ?? post.scheduled_at;
  if (sched) {
    const t = Date.parse(sched);
    if (Number.isNaN(t)) return json(400, { error: 'invalid scheduled_at' });
    if (t >= Date.now() + 30_000) isScheduled = true; // past/near times publish immediately
  }

  // (Re)create pending send rows for exactly the current channel set.
  await ctx.db.query(`DELETE FROM social_post_sends WHERE post_id = $1 AND channel <> ALL($2::text[])`, [post_id, channels]);
  for (const channel of channels) {
    await ctx.db.query(
      `INSERT INTO social_post_sends (workspace_id, post_id, channel, status, error, external_post_id, external_url)
       VALUES ($1, $2, $3, 'pending', NULL, NULL, NULL)
       ON CONFLICT (post_id, channel) DO UPDATE SET status = 'pending', error = NULL`,
      [post.workspace_id, post_id, channel],
    );
  }

  const status = isScheduled ? 'scheduled' : 'sending';
  await ctx.db.query(
    `UPDATE social_posts SET status = $2, scheduled_at = $3, updated_at = now() WHERE id = $1`,
    [post_id, status, isScheduled ? sched : null],
  );

  if (!isScheduled) {
    const p = ctx.invoke(
      'send-social-post',
      { post_id },
      { headers: { 'x-butterbase-as-user': ctx.user.id } },
    ).catch((e) => console.error(`[publish-social-post] dispatch_failed post=${post_id}: ${e?.message ?? e}`));
    if (typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  }

  return json(200, { id: post_id, status });
}
