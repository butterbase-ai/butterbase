import { useEffect, useMemo, useState } from 'react'
import { Loader2, ChevronDown, ChevronRight, Tag, X, ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentWorkspaceId } from '@/lib/workspace'
import { useSocialConnections } from '@/hooks/useSocialConnections'
import {
  createSocialPost,
  editSocialPost,
  publishSocialPost,
  getSubredditFlairs,
  type ChannelOverrides,
  type SocialChannel,
  type SocialPost,
  type SubredditFlair,
  type MediaRef,
} from '@/lib/socialApi'
import { XIcon, LinkedInIcon, RedditIcon, InstagramIcon, TikTokIcon } from '@/components/SocialIcons'
import { bb } from '@/lib/butterbase'

const META: Record<SocialChannel, { name: string; limit: number; icon: (p: React.SVGProps<SVGSVGElement>) => React.ReactElement }> = {
  twitter: { name: 'Twitter', limit: 280, icon: XIcon },
  linkedin: { name: 'LinkedIn', limit: 3000, icon: LinkedInIcon },
  reddit: { name: 'Reddit', limit: 40000, icon: RedditIcon },
  instagram: { name: 'Instagram', limit: 2200, icon: InstagramIcon },
  tiktok: { name: 'TikTok', limit: 2200, icon: TikTokIcon },
}

const UPCOMING_CHANNELS: ReadonlySet<SocialChannel> = new Set(['instagram', 'tiktok'])

function canPostTo(channel: SocialChannel, m: MediaRef[]): { ok: boolean; reason?: string } {
  if (channel === 'twitter') {
    if (m.length === 0) return { ok: true }
    const hasVideo = m.some(x => x.kind === 'video')
    if (hasVideo && m.length !== 1) return { ok: false, reason: 'Twitter: video posts need exactly 1 video' }
    if (!hasVideo && m.length > 4) return { ok: false, reason: 'Twitter: up to 4 images' }
    return { ok: true }
  }
  if (channel === 'linkedin') {
    if (m.length > 1) return { ok: false, reason: 'LinkedIn: max 1 media item' }
    return { ok: true }
  }
  if (channel === 'reddit') return { ok: true }
  if (channel === 'instagram') {
    if (m.length === 0) return { ok: false, reason: 'Instagram requires media' }
    if (m.length > 10) return { ok: false, reason: 'Instagram carousels max 10 items' }
    return { ok: true }
  }
  if (channel === 'tiktok') {
    if (m.length === 0) return { ok: false, reason: 'TikTok requires media' }
    const kinds = new Set(m.map(x => x.kind))
    if (kinds.size > 1) return { ok: false, reason: 'TikTok: cannot mix images and videos' }
    if (m[0].kind === 'video' && m.length > 1) return { ok: false, reason: 'TikTok video: exactly 1 clip' }
    if (m[0].kind === 'image' && m.length > 35) return { ok: false, reason: 'TikTok photo: max 35 images' }
    return { ok: true }
  }
  return { ok: true }
}

function eff(body: string, override?: string) {
  return (typeof override === 'string' && override.length > 0) ? override : body
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** Existing post to edit. Omit for a fresh "create" composer. */
  post?: SocialPost | null
  /** Prefill a fresh create-mode composer (e.g. from an AI draft). Ignored when `post` is set. */
  initialContent?: { body?: string; channels?: SocialChannel[]; channel_overrides?: ChannelOverrides } | null
}

export function SocialPostComposer({ open, onOpenChange, post, initialContent }: Props) {
  const ws = useCurrentWorkspaceId()
  const { data: connections = [] } = useSocialConnections(ws ?? null)
  const qc = useQueryClient()

  const isEdit = !!post
  const isPublished = post ? ['sent', 'partial'].includes(post.status) : false

  const [selectedChannels, setSelectedChannels] = useState<SocialChannel[]>([])
  const [body, setBody] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [twOverride, setTwOverride] = useState('')
  const [liOverride, setLiOverride] = useState('')
  const [twExpanded, setTwExpanded] = useState(false)
  const [liExpanded, setLiExpanded] = useState(false)
  const [redditSubreddit, setRedditSubreddit] = useState('')
  const [redditTitle, setRedditTitle] = useState('')
  const [redditFlairId, setRedditFlairId] = useState('')
  const [redditBody, setRedditBody] = useState('')
  const [isScheduled, setIsScheduled] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [pushToPlatform, setPushToPlatform] = useState(false)
  const [busy, setBusy] = useState(false)

  const [media, setMedia] = useState<MediaRef[]>([])
  const [uploading, setUploading] = useState(false)
  const [igPostType, setIgPostType] = useState<'feed'|'reel'|'story'|'carousel'>('feed')
  const [ttPostType, setTtPostType] = useState<'video'|'photo'>('video')
  const [ttTitle, setTtTitle] = useState('')
  const [ttPrivacy, setTtPrivacy] = useState<'PUBLIC_TO_EVERYONE'|'MUTUAL_FOLLOW_FRIENDS'|'SELF_ONLY'>('PUBLIC_TO_EVERYONE')
  const [igCaption, setIgCaption] = useState('')
  const [ttCaption, setTtCaption] = useState('')

  // Reddit flair dropdown
  const [flairs, setFlairs] = useState<SubredditFlair[]>([])
  const [flairLoading, setFlairLoading] = useState(false)

  const connectedSlugs = useMemo(
    () => new Set(connections.filter((c) => c.status === 'active').map((c) => c.toolkit_slug)),
    [connections],
  )

  // (Re)initialize the form whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    // `post` (edit existing) takes precedence; otherwise seed from initialContent (create-mode prefill).
    const seed = post ?? initialContent ?? null
    const o = (seed?.channel_overrides ?? {}) as ChannelOverrides
    setSelectedChannels(seed?.channels ?? [])
    setBody(seed?.body ?? '')
    setLinkUrl((seed as SocialPost | null)?.link_url ?? '')
    setTwOverride(o.twitter?.body ?? '')
    setLiOverride(o.linkedin?.body ?? '')
    setTwExpanded(!!o.twitter?.body)
    setLiExpanded(!!o.linkedin?.body)
    setRedditSubreddit(o.reddit?.subreddit ?? '')
    setRedditTitle(o.reddit?.title ?? '')
    setRedditFlairId(o.reddit?.flair_id ?? '')
    setRedditBody(o.reddit?.body ?? '')
    setIgCaption(o.instagram?.caption ?? '')
    const seedMedia = (seed as SocialPost | null)?.media ?? []
    setMedia(seedMedia)
    setIgPostType((o.instagram?.post_type ?? (seedMedia.length >= 2 ? 'carousel' : 'feed')) as any)
    setTtCaption(o.tiktok?.caption ?? '')
    setTtPostType((o.tiktok?.post_type ?? 'video') as any)
    setTtTitle(o.tiktok?.title ?? '')
    setTtPrivacy((o.tiktok?.privacy ?? 'PUBLIC_TO_EVERYONE') as any)
    setPushToPlatform(false)
    setFlairs([])
    if (post?.scheduled_at) {
      const d = new Date(post.scheduled_at)
      setIsScheduled(true)
      setScheduleDate(d.toISOString().slice(0, 10))
      setScheduleTime(d.toTimeString().slice(0, 5))
    } else {
      setIsScheduled(false)
      setScheduleDate('')
      setScheduleTime('')
    }
  }, [open, post, initialContent])

  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      const uploaded: MediaRef[] = []
      for (const f of Array.from(files)) {
        const kind: 'image' | 'video' = f.type.startsWith('video/') ? 'video' : 'image'
        const res = await bb.storage.upload(f, f.name)
        if (res.error) throw res.error
        uploaded.push({ object_id: res.data!.objectId, kind, mime: f.type, size_bytes: f.size })
      }
      setMedia((cur) => [...cur, ...uploaded])
    } catch (e: any) {
      toast.error(e?.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function removeMedia(idx: number) {
    setMedia((cur) => cur.filter((_, i) => i !== idx))
  }

  function moveMedia(idx: number, dir: -1 | 1) {
    setMedia((cur) => {
      const next = [...cur]
      const j = idx + dir
      if (j < 0 || j >= next.length) return cur
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  function toggleChannel(c: SocialChannel) {
    setSelectedChannels((cur) => (cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]))
  }

  async function loadFlairs() {
    if (!ws) return
    const sub = redditSubreddit.trim().replace(/^\/?r\//i, '').replace(/\//g, '')
    if (!sub) { toast.error('Enter a subreddit first'); return }
    setFlairLoading(true)
    try {
      const { data, error } = await getSubredditFlairs(ws, sub)
      if (error) throw new Error(typeof error === 'string' ? error : (error?.error ?? 'Failed to load flairs'))
      setFlairs(data?.flairs ?? [])
      if (!data?.flairs?.length) toast.info(`r/${sub} has no selectable flairs`)
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to load flairs')
    } finally {
      setFlairLoading(false)
    }
  }

  function buildOverrides(): ChannelOverrides {
    const co: ChannelOverrides = {}
    if (twOverride.trim()) co.twitter = { body: twOverride.trim() }
    if (liOverride.trim()) co.linkedin = { body: liOverride.trim() }
    if (selectedChannels.includes('reddit')) {
      co.reddit = {
        title: redditTitle.trim(),
        subreddit: redditSubreddit.trim().replace(/^\/?r\//i, '').replace(/\//g, ''),
        ...(redditFlairId.trim() ? { flair_id: redditFlairId.trim() } : {}),
        ...(redditBody.trim() ? { body: redditBody.trim() } : {}),
      }
    }
    if (selectedChannels.includes('instagram')) {
      co.instagram = {
        ...(igCaption.trim() ? { caption: igCaption.trim() } : {}),
        post_type: igPostType,
      }
    }
    if (selectedChannels.includes('tiktok')) {
      co.tiktok = {
        ...(ttCaption.trim() ? { caption: ttCaption.trim() } : {}),
        ...(ttTitle.trim() ? { title: ttTitle.trim() } : {}),
        post_type: ttPostType,
        privacy: ttPrivacy,
      }
    }
    return co
  }

  function scheduledIso(): string | undefined | null {
    if (!isScheduled) return null
    if (!scheduleDate || !scheduleTime) { toast.error('Pick a date and time'); throw new Error('schedule') }
    const dt = new Date(`${scheduleDate}T${scheduleTime}`)
    if (Number.isNaN(dt.getTime())) { toast.error('Invalid date/time'); throw new Error('schedule') }
    if (dt.getTime() < Date.now() + 30_000) { toast.error('Pick a time at least 30s from now'); throw new Error('schedule') }
    return dt.toISOString()
  }

  function validateForSend(): boolean {
    if (selectedChannels.length === 0) { toast.error('Pick at least one channel'); return false }
    if (!body.trim()) { toast.error('Write a body'); return false }
    if (selectedChannels.includes('reddit')) {
      if (!redditSubreddit.trim()) { toast.error('Reddit needs a subreddit'); return false }
      if (!redditTitle.trim()) { toast.error('Reddit needs a title'); return false }
    }
    return true
  }

  function done(msg: string) {
    toast.success(msg)
    qc.invalidateQueries({ queryKey: ['social-posts'] })
    onOpenChange(false)
  }

  // ---- Actions ----

  async function saveDraft() {
    if (!ws) { toast.error('No workspace'); return }
    if (!body.trim()) { toast.error('Write a body'); return }
    setBusy(true)
    try {
      if (isEdit) {
        const { error } = await editSocialPost(post!.id, {
          body: body.trim(),
          channels: selectedChannels,
          channel_overrides: buildOverrides(),
          link_url: linkUrl.trim() || null,
          media,
        })
        if (error) throw new Error(errMsg(error))
        done('Draft saved')
      } else {
        const { error } = await createSocialPost({
          workspace_id: ws,
          body: body.trim(),
          channels: selectedChannels,
          channel_overrides: buildOverrides(),
          link_url: linkUrl.trim() || undefined,
          save_as_draft: true,
          media,
        })
        if (error) throw new Error(errMsg(error))
        done('Draft saved')
      }
    } catch (e: any) {
      if (e?.message !== 'schedule') toast.error(e?.message ?? 'Failed to save draft')
    } finally {
      setBusy(false)
    }
  }

  async function publishOrSchedule() {
    if (!ws) { toast.error('No workspace'); return }
    if (!validateForSend()) return
    setBusy(true)
    try {
      const sched = scheduledIso()
      if (isEdit) {
        // Persist edits first, then publish.
        const { error: eErr } = await editSocialPost(post!.id, {
          body: body.trim(),
          channels: selectedChannels,
          channel_overrides: buildOverrides(),
          link_url: linkUrl.trim() || null,
          scheduled_at: sched,
          media,
        })
        if (eErr) throw new Error(errMsg(eErr))
        const { error: pErr } = await publishSocialPost(post!.id, sched || undefined)
        if (pErr) throw new Error(errMsg(pErr))
        done(sched ? 'Scheduled' : 'Publishing…')
      } else {
        const { error } = await createSocialPost({
          workspace_id: ws,
          body: body.trim(),
          channels: selectedChannels,
          channel_overrides: buildOverrides(),
          link_url: linkUrl.trim() || undefined,
          ...(sched ? { scheduled_at: sched } : {}),
          media,
        })
        if (error) throw new Error(errMsg(error))
        done(sched ? 'Post scheduled' : 'Publishing…')
      }
    } catch (e: any) {
      if (e?.message !== 'schedule') toast.error(e?.message ?? 'Failed to publish')
    } finally {
      setBusy(false)
    }
  }

  // Edit a post that's already published: save CRM copy + optionally push body to the platform.
  async function saveEditPublished() {
    if (!body.trim()) { toast.error('Write a body'); return }
    setBusy(true)
    try {
      const { data, error } = await editSocialPost(
        post!.id,
        { body: body.trim(), channel_overrides: buildOverrides(), media },
        pushToPlatform,
      )
      if (error) throw new Error(errMsg(error))
      const failed = (data?.platform ?? []).filter((p) => !p.ok)
      if (pushToPlatform && failed.length) {
        toast.warning(`Saved, but couldn't update on: ${failed.map((f) => f.channel).join(', ')}`, {
          description: failed[0]?.error ?? undefined,
        })
        qc.invalidateQueries({ queryKey: ['social-posts'] })
        onOpenChange(false)
      } else {
        done(pushToPlatform ? 'Saved & updated on platform' : 'Changes saved')
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to save')
    } finally {
      setBusy(false)
    }
  }

  const title = !isEdit ? 'New social post' : isPublished ? 'Edit published post' : 'Edit post'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-tight">{title}</DialogTitle>
        </DialogHeader>

        {isPublished && (
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            This post is already published. Reddit self-post bodies can be updated on-platform; titles, link posts,
            LinkedIn and X can't be edited after posting.
          </div>
        )}

        <div className="space-y-4">
          <div>
            <Label className="eyebrow !text-[10px]">Channels</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {(Object.keys(META) as SocialChannel[]).map((slug) => {
                const isOn = selectedChannels.includes(slug)
                const isConnected = connectedSlugs.has(slug)
                const lockedChannels = isPublished
                const compat = canPostTo(slug, media)
                const isUpcoming = UPCOMING_CHANNELS.has(slug)
                const disabled = isUpcoming || !isConnected || lockedChannels || !compat.ok
                const I = META[slug].icon
                return (
                  <button
                    key={slug}
                    type="button"
                    disabled={disabled}
                    title={isUpcoming ? `${META[slug].name} — coming soon` : lockedChannels ? 'Channels are locked for a published post' : (!isConnected ? 'Connect in Settings →' : (compat.reason ?? undefined))}
                    onClick={() => toggleChannel(slug)}
                    className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm transition ${
                      isOn ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                    } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <I className="h-4 w-4" />
                    <span>{META[slug].name}</span>
                    {isUpcoming && (
                      <span className="ml-1 rounded-full border border-gray-200 bg-gray-50 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wide text-gray-500">
                        Soon
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <Label className="eyebrow !text-[10px]">Body</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="What's the news?" rows={4} className="mt-1" />
            <div className="mt-1 flex gap-3 text-[11px] text-gray-500">
              {selectedChannels.includes('twitter') && (() => {
                const len = eff(body, twOverride).length
                const cls = len > META.twitter.limit ? 'text-amber-600 font-medium' : 'text-green-600'
                return <span className={`inline-flex items-center gap-1 ${cls}`}><XIcon className="h-3 w-3" /> {len}/{META.twitter.limit}</span>
              })()}
              {selectedChannels.includes('linkedin') && (() => {
                const len = eff(body, liOverride).length
                const cls = len > META.linkedin.limit ? 'text-amber-600 font-medium' : 'text-green-600'
                return <span className={`inline-flex items-center gap-1 ${cls}`}><LinkedInIcon className="h-3 w-3" /> {len}/{META.linkedin.limit}</span>
              })()}
            </div>
          </div>

          <div>
            <Label className="eyebrow !text-[10px]">Link (optional)</Label>
            <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" className="mt-1" />
          </div>

          <div>
            <Label className="eyebrow !text-[10px]">Media</Label>
            <div className="mt-1 space-y-2">
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 cursor-pointer rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:border-gray-300">
                  <ImagePlus className="h-4 w-4" />
                  {uploading ? 'Uploading…' : 'Add images / videos'}
                  <input
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    disabled={uploading || isPublished}
                    onChange={(e) => { handleUpload(e.currentTarget.files); e.currentTarget.value = '' }}
                    className="hidden"
                  />
                </label>
                {media.length > 0 && <span className="text-[11px] text-gray-500">{media.length} item{media.length === 1 ? '' : 's'}</span>}
              </div>
              {media.length > 0 && (
                <div className="flex gap-2 overflow-x-auto">
                  {media.map((m, i) => (
                    <div key={m.object_id} className="relative shrink-0 rounded border border-gray-200 bg-gray-50 p-1">
                      <div className="flex h-16 w-16 items-center justify-center rounded bg-gray-200 text-[10px] text-gray-500 uppercase">
                        {m.kind}
                      </div>
                      <button type="button" onClick={() => removeMedia(i)} className="absolute -right-1 -top-1 rounded-full bg-white p-0.5 text-gray-500 shadow">
                        <X className="h-3 w-3" />
                      </button>
                      {media.length > 1 && (
                        <div className="mt-1 flex justify-center gap-1 text-[9px] text-gray-500">
                          <button type="button" onClick={() => moveMedia(i, -1)} disabled={i === 0}>◀</button>
                          <button type="button" onClick={() => moveMedia(i, 1)} disabled={i === media.length - 1}>▶</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {selectedChannels.includes('twitter') && (
            <div className="rounded border border-gray-200 bg-gray-50 p-2">
              <button type="button" onClick={() => setTwExpanded((v) => !v)} className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
                {twExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Customize for Twitter
              </button>
              {twExpanded && (
                <Textarea value={twOverride} onChange={(e) => setTwOverride(e.target.value)} placeholder="Twitter-specific body (≤ 280 chars). Empty = use shared body." rows={3} className="mt-2 text-sm" />
              )}
            </div>
          )}

          {selectedChannels.includes('linkedin') && (
            <div className="rounded border border-gray-200 bg-gray-50 p-2">
              <button type="button" onClick={() => setLiExpanded((v) => !v)} className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900">
                {liExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />} Customize for LinkedIn
              </button>
              {liExpanded && (
                <Textarea value={liOverride} onChange={(e) => setLiOverride(e.target.value)} placeholder="LinkedIn-specific body. Empty = use shared body." rows={3} className="mt-2 text-sm" />
              )}
            </div>
          )}

          {selectedChannels.includes('instagram') && (
            <div className="rounded border border-pink-200 bg-pink-50 p-3 space-y-2">
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-pink-900 uppercase tracking-wide">
                <InstagramIcon className="h-3.5 w-3.5" /> Instagram
              </div>
              <div>
                <Label className="text-xs">Post type</Label>
                <div className="mt-1 flex gap-2 text-sm">
                  {(['feed','reel','story','carousel'] as const).map(t => (
                    <label key={t} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" checked={igPostType === t} onChange={() => setIgPostType(t)} disabled={
                        (t === 'reel' && (media[0]?.kind !== 'video')) ||
                        (t === 'carousel' && media.length < 2)
                      } /> {t}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <Label className="text-xs">Caption override (optional)</Label>
                <Textarea value={igCaption} onChange={(e) => setIgCaption(e.target.value)} rows={2} placeholder="Empty = use shared body" className="mt-1 text-sm" />
                <div className={`mt-0.5 text-[10px] ${igCaption.length > 2200 ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>{eff(body, igCaption).length}/2200</div>
              </div>
            </div>
          )}

          {selectedChannels.includes('tiktok') && (
            <div className="rounded border border-neutral-200 bg-neutral-50 p-3 space-y-2">
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-neutral-900 uppercase tracking-wide">
                <TikTokIcon className="h-3.5 w-3.5" /> TikTok
              </div>
              <div>
                <Label className="text-xs">Post type</Label>
                <div className="mt-1 flex gap-2 text-sm">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" checked={ttPostType === 'video'} onChange={() => setTtPostType('video')} disabled={media[0]?.kind !== 'video'} /> video
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input type="radio" checked={ttPostType === 'photo'} onChange={() => setTtPostType('photo')} disabled={media[0]?.kind !== 'image'} /> photo
                  </label>
                </div>
              </div>
              <div>
                <Label className="text-xs">Title (optional)</Label>
                <Input value={ttTitle} onChange={(e) => setTtTitle(e.target.value)} className="mt-1 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Privacy</Label>
                <select value={ttPrivacy} onChange={(e) => setTtPrivacy(e.target.value as any)} className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm">
                  <option value="PUBLIC_TO_EVERYONE">Public</option>
                  <option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
                  <option value="SELF_ONLY">Only me</option>
                </select>
              </div>
              <div>
                <Label className="text-xs">Caption override (optional)</Label>
                <Textarea value={ttCaption} onChange={(e) => setTtCaption(e.target.value)} rows={2} placeholder="Empty = use shared body" className="mt-1 text-sm" />
                <div className={`mt-0.5 text-[10px] ${ttCaption.length > 2200 ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>{eff(body, ttCaption).length}/2200</div>
              </div>
            </div>
          )}

          {selectedChannels.includes('reddit') && (
            <div className="rounded border border-orange-200 bg-orange-50 p-3 space-y-2">
              <div className="inline-flex items-center gap-1 text-[11px] font-semibold text-orange-900 uppercase tracking-wide">
                <RedditIcon className="h-3.5 w-3.5" /> Reddit (required fields)
              </div>
              <div>
                <Label className="text-xs">Subreddit</Label>
                <Input value={redditSubreddit} onChange={(e) => setRedditSubreddit(e.target.value)} placeholder="r/startups (without slash)" className="mt-1 text-sm" />
              </div>
              <div>
                <Label className="text-xs">Title (≤ 300 chars)</Label>
                <Input value={redditTitle} onChange={(e) => setRedditTitle(e.target.value)} className="mt-1 text-sm" />
                <div className={`mt-0.5 text-[10px] ${redditTitle.length > 300 ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>{redditTitle.length}/300</div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Flair</Label>
                  <button
                    type="button"
                    onClick={loadFlairs}
                    disabled={flairLoading || !redditSubreddit.trim()}
                    className="inline-flex items-center gap-1 text-[11px] text-orange-800 hover:underline disabled:opacity-40"
                  >
                    {flairLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Tag className="h-3 w-3" />}
                    Load flairs
                  </button>
                </div>
                {flairs.length > 0 ? (
                  <select
                    value={redditFlairId}
                    onChange={(e) => setRedditFlairId(e.target.value)}
                    className="mt-1 w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm"
                  >
                    <option value="">No flair</option>
                    {flairs.map((f) => <option key={f.id} value={f.id}>{f.text || f.css_class || f.id}</option>)}
                  </select>
                ) : (
                  <Input value={redditFlairId} onChange={(e) => setRedditFlairId(e.target.value)} placeholder="Flair ID — click 'Load flairs' to pick" className="mt-1 text-sm" />
                )}
              </div>
              <div>
                <Label className="text-xs">Body override (optional)</Label>
                <Textarea value={redditBody} onChange={(e) => setRedditBody(e.target.value)} placeholder="Empty = use shared body" rows={2} className="mt-1 text-sm" />
              </div>
            </div>
          )}

          {!isPublished && (
            <div>
              <Label className="eyebrow !text-[10px]">Schedule</Label>
              <div className="mt-1 flex gap-4 text-sm">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={!isScheduled} onChange={() => setIsScheduled(false)} /> Publish now
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="radio" checked={isScheduled} onChange={() => setIsScheduled(true)} /> Schedule for
                </label>
              </div>
              {isScheduled && (
                <div className="mt-2 flex gap-2">
                  <Input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="text-sm" />
                  <Input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="text-sm" />
                  <span className="self-center text-[11px] text-gray-500">local TZ</span>
                </div>
              )}
            </div>
          )}

          {isPublished && (
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={pushToPlatform} onChange={(e) => setPushToPlatform(e.target.checked)} />
              Also update the live post on the platform (Reddit body only)
            </label>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          {isPublished ? (
            <Button onClick={saveEditPublished} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save changes
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={saveDraft} disabled={busy}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save draft
              </Button>
              <Button onClick={publishOrSchedule} disabled={busy}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} {isScheduled ? 'Schedule' : 'Publish'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function errMsg(error: any): string {
  return typeof error === 'string' ? error : (error?.error ?? error?.message ?? 'Request failed')
}
