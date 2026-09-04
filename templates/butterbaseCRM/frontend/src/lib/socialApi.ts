import { bb, bbInvoke } from './butterbase'

export type SocialChannel = 'twitter' | 'linkedin' | 'reddit' | 'instagram' | 'tiktok'

export type SocialPostStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'canceled'

export type SocialSendStatus = 'pending' | 'sent' | 'failed'

export interface MediaRef {
  object_id: string
  kind: 'image' | 'video'
  mime: string
  size_bytes: number
}

export interface ChannelOverrides {
  twitter?: { body?: string }
  linkedin?: { body?: string; visibility?: 'PUBLIC' | 'CONNECTIONS' | 'LOGGED_IN' }
  reddit?: { title: string; subreddit: string; flair_id?: string; body?: string }
  instagram?: { caption?: string; post_type?: 'feed' | 'reel' | 'story' | 'carousel' }
  tiktok?: {
    caption?: string
    title?: string
    post_type?: 'video' | 'photo'
    privacy?: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY'
  }
}

export interface SocialPost {
  id: string
  workspace_id: string
  created_by: string
  body: string
  channels: SocialChannel[]
  channel_overrides: ChannelOverrides
  media: MediaRef[]
  link_url: string | null
  scheduled_at: string | null
  status: SocialPostStatus
  error: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface SocialPostSend {
  id: string
  workspace_id: string
  post_id: string
  channel: SocialChannel
  status: SocialSendStatus
  external_post_id: string | null
  external_url: string | null
  error: string | null
  attempts: number
  sent_at: string | null
  created_at: string
}

export interface CreatePayload {
  workspace_id: string
  body: string
  channels: SocialChannel[]
  channel_overrides?: ChannelOverrides
  media?: MediaRef[]
  link_url?: string
  scheduled_at?: string
  save_as_draft?: boolean
}

export interface CreateResult {
  id: string
  status: SocialPostStatus
}

export async function createSocialPost(payload: CreatePayload) {
  return bbInvoke<CreateResult>('create-social-post', payload)
}

// ---- Edit / publish / repost / flairs ----

export interface EditPatch {
  body?: string
  channels?: SocialChannel[]
  channel_overrides?: ChannelOverrides
  media?: MediaRef[]
  link_url?: string | null
  scheduled_at?: string | null
}

export interface PlatformEditResult {
  channel: SocialChannel
  ok: boolean
  error: string | null
}

export async function editSocialPost(post_id: string, patch: EditPatch, push_to_platform = false) {
  return bbInvoke<{ ok: boolean; status: SocialPostStatus; platform: PlatformEditResult[] }>(
    'edit-social-post',
    { post_id, patch, push_to_platform },
  )
}

export async function publishSocialPost(post_id: string, scheduled_at?: string) {
  return bbInvoke<{ id: string; status: SocialPostStatus }>('publish-social-post', {
    post_id,
    ...(scheduled_at ? { scheduled_at } : {}),
  })
}

// "Repost" — clone an existing post into a new editable draft.
export async function cloneSocialPost(post_id: string) {
  return bbInvoke<{ id: string; status: SocialPostStatus; cloned_from: string }>('clone-social-post', { post_id })
}

export interface SubredditFlair {
  id: string
  text: string
  css_class: string | null
}

export async function getSubredditFlairs(workspace_id: string, subreddit: string) {
  return bbInvoke<{ subreddit: string; flair_required: boolean; flairs: SubredditFlair[] }>(
    'get-subreddit-flairs',
    { workspace_id, subreddit },
  )
}

export async function retrySocialPost(post_id: string) {
  return bbInvoke<{ ok: boolean; status: SocialPostStatus }>('send-social-post', {
    post_id,
    retry: true,
  })
}

export async function cancelScheduledPost(post_id: string) {
  const { data, error } = await bb
    .from('social_posts')
    .update({ status: 'canceled', updated_at: new Date().toISOString() } as any)
    .eq('id', post_id)
    .eq('status', 'scheduled')
  if (error) throw error
  return data
}

export async function deleteSocialPost(post_id: string) {
  const { error } = await bb.from('social_posts').delete().eq('id', post_id)
  if (error) throw error
}

export async function deleteFromPlatform(send_id: string) {
  return bbInvoke<{ ok: boolean; note?: string; error?: string }>('delete-social-post-from-platform', { send_id })
}

export async function listSocialPosts(workspace_id: string) {
  const { data, error } = await bb
    .from('social_posts')
    .select('*')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as SocialPost[]
}

export async function listSocialPostSends(post_ids: string[]) {
  if (post_ids.length === 0) return [] as SocialPostSend[]
  const { data, error } = await bb
    .from('social_post_sends')
    .select('*')
    .in('post_id', post_ids)
  if (error) throw error
  return (data ?? []) as SocialPostSend[]
}

// ---- Comments ----

export interface CommentPayload {
  workspace_id: string
  channel: 'reddit' | 'linkedin'
  target_post_id: string
  target_post_url?: string
  body: string
  entity_type?: string
  entity_id?: string
}

export interface CommentResult {
  id: string
  status: string
  external_comment_id: string | null
  external_url: string | null
}

export async function commentOnSocialPost(payload: CommentPayload) {
  return bbInvoke<CommentResult>('comment-on-social-post', payload)
}

export interface SocialComment {
  id: string
  workspace_id: string
  created_by: string
  channel: 'reddit' | 'linkedin' | 'twitter'
  target_post_id: string
  target_post_url: string | null
  body: string
  status: 'pending' | 'sent' | 'failed'
  external_comment_id: string | null
  external_url: string | null
  error: string | null
  entity_type: string | null
  entity_id: string | null
  created_at: string
  updated_at: string
}

export async function listSocialComments(workspace_id: string) {
  const { data, error } = await bb
    .from('social_comments')
    .select('*')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as SocialComment[]
}

export async function retrySocialComment(comment_id: string) {
  return bbInvoke<CommentResult>('comment-on-social-post', { comment_id, retry: true })
}

export async function deleteSocialComment(comment_id: string) {
  const { error } = await bb.from('social_comments').delete().eq('id', comment_id)
  if (error) throw error
}

// ---- Comment Campaigns ----

export interface TargetingSpec {
  // Reddit
  subreddits?: string[]
  keywords?: string
  sort?: 'hot' | 'new' | 'top' | 'relevance'
  time_filter?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all'
  limit?: number
  // LinkedIn
  post_urls?: string[]
  // Shared
  persona_instructions?: string
  tone?: string
}

export interface CampaignItem {
  id: string
  target_post_id: string
  title: string
  draft: string
}

export interface DiscoverResult {
  campaign_id: string
  item_count: number
  items: CampaignItem[]
}

export interface ExecuteResult {
  campaign_id: string
  posted: number
  failed: number
  results: { id: string; status: 'sent' | 'failed'; error?: string; social_comment_id?: string }[]
}

export async function discoverCommentTargets(payload: {
  workspace_id: string
  name: string
  channel: 'reddit' | 'linkedin' | 'twitter'
  targeting_spec: TargetingSpec
}) {
  return bbInvoke<DiscoverResult>('discover-comment-targets', payload)
}

export async function executeCommentCampaign(payload: {
  campaign_id: string
  item_ids: string[]
  final_comments?: Record<string, string>
}) {
  return bbInvoke<ExecuteResult>('execute-comment-campaign', payload)
}

export interface CommentCampaign {
  id: string
  workspace_id: string
  created_by: string
  name: string
  channel: string
  targeting_spec: TargetingSpec
  status: string
  item_count: number
  posted_count: number
  created_at: string
  updated_at: string
}

export async function listCommentCampaigns(workspace_id: string) {
  const { data, error } = await bb
    .from('comment_campaigns')
    .select('*')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as CommentCampaign[]
}

// ---- Reply Inbox ----

export interface ReplyInboxItem {
  id: string
  workspace_id: string
  send_id: string
  channel: 'reddit'
  external_reply_id: string
  external_post_id: string
  author_name: string | null
  body: string
  score: number
  external_url: string | null
  replied_at: string | null
  fetched_at: string
  created_at: string
}

export async function listReplyInbox(workspace_id: string) {
  const { data, error } = await bb
    .from('social_reply_inbox')
    .select('*')
    .eq('workspace_id', workspace_id)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as ReplyInboxItem[]
}

export async function replyToInboxItem(inbox_item_id: string, body: string) {
  return bbInvoke<{ ok: boolean; external_reply_id: string | null }>('reply-to-inbox-item', {
    inbox_item_id,
    body,
  })
}
