import { useState } from 'react'
import { ExternalLink, Loader2, CheckCircle2, XCircle, ChevronLeft } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { discoverCommentTargets, executeCommentCampaign, type CampaignItem } from '@/lib/socialApi'
import { parseLinkedInUrn } from '@/components/NewSocialCommentDialog'

function parseTweetUrl(raw: string): { id: string | null; warning?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { id: null }
  const urlMatch = trimmed.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/)
  if (urlMatch) return { id: urlMatch[1] }
  if (/^\d+$/.test(trimmed)) return { id: trimmed }
  return { id: null, warning: 'Not a valid tweet URL or ID' }
}
import { RedditIcon, LinkedInIcon, XIcon } from '@/components/SocialIcons'
import { useSocialConnections } from '@/hooks/useSocialConnections'
import { useCurrentWorkspaceId } from '@/lib/workspace'
import { useQueryClient } from '@tanstack/react-query'

type Channel = 'reddit' | 'linkedin' | 'twitter'
type Step = 'targeting' | 'review' | 'done'

interface ReviewItem extends CampaignItem {
  selected: boolean
  editedDraft: string
}

const CHANNEL_META: Record<Channel, { label: string; Icon: typeof RedditIcon }> = {
  reddit: { label: 'Reddit', Icon: RedditIcon },
  linkedin: { label: 'LinkedIn', Icon: LinkedInIcon },
  twitter: { label: 'X', Icon: XIcon },
}

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'hot', label: 'Hot' },
  { value: 'new', label: 'New' },
  { value: 'top', label: 'Top' },
]

export function CommentCampaignDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const ws = useCurrentWorkspaceId()
  const qc = useQueryClient()
  const { data: connections = [] } = useSocialConnections(ws)

  const [step, setStep] = useState<Step>('targeting')
  const [channel, setChannel] = useState<Channel>('reddit')
  const [name, setName] = useState('')

  // Reddit targeting
  const [keywords, setKeywords] = useState('')
  const [subreddits, setSubreddits] = useState('')
  const [sort, setSort] = useState<'relevance' | 'hot' | 'new' | 'top'>('relevance')
  const [postCount, setPostCount] = useState('10')

  // LinkedIn targeting
  const [postUrlsRaw, setPostUrlsRaw] = useState('')

  // Shared
  const [persona, setPersona] = useState('')
  const [tone, setTone] = useState('professional and genuine')

  const [discovering, setDiscovering] = useState(false)
  const [campaignId, setCampaignId] = useState<string | null>(null)
  const [items, setItems] = useState<ReviewItem[]>([])
  const [executing, setExecuting] = useState(false)
  const [doneResult, setDoneResult] = useState<{ posted: number; failed: number } | null>(null)

  const connectedSlugs = new Set(connections.filter((c) => c.status === 'active').map((c) => c.toolkit_slug))

  function reset() {
    setStep('targeting')
    setChannel('reddit')
    setName('')
    setKeywords('')
    setSubreddits('')
    setSort('relevance')
    setPostCount('10')
    setPostUrlsRaw('')
    setPersona('')
    setTone('professional and genuine')
    setCampaignId(null)
    setItems([])
    setDoneResult(null)
  }

  // URL validation
  const urlLines = postUrlsRaw.split('\n').map((s) => s.trim()).filter(Boolean)
  const linkedInPreviews = channel === 'linkedin'
    ? urlLines.map((url) => ({ url, parsed: parseLinkedInUrn(url) }))
    : []
  const tweetPreviews = channel === 'twitter'
    ? urlLines.map((url) => ({ url, parsed: parseTweetUrl(url) }))
    : []
  const hasLinkedInErrors = linkedInPreviews.some((p) => !!p.parsed.warning)
  const hasTweetErrors = tweetPreviews.some((p) => !!p.parsed.warning)

  const canDiscover = !!name.trim() && connectedSlugs.has(channel) && (
    channel === 'reddit'
      ? (!!keywords.trim() || !!subreddits.trim())
      : channel === 'twitter'
      ? (tweetPreviews.length > 0 && !hasTweetErrors)
      : (urlLines.length > 0 && !hasLinkedInErrors)
  )

  async function handleDiscover() {
    if (!ws || !canDiscover) return
    setDiscovering(true)
    try {
      const limit = Math.max(1, Math.min(25, parseInt(postCount, 10) || 10))

      const targeting_spec = channel === 'reddit'
        ? {
            keywords: keywords.trim(),
            subreddits: subreddits.split(',').map((s) => s.trim()).filter(Boolean),
            sort,
            limit,
            persona_instructions: persona.trim() || undefined,
            tone: tone.trim() || undefined,
          }
        : {
            post_urls: urlLines,
            persona_instructions: persona.trim() || undefined,
            tone: tone.trim() || undefined,
          }

      const { data: res, error } = await discoverCommentTargets({
        workspace_id: ws,
        name: name.trim(),
        channel,
        targeting_spec,
      })
      if (error || !res) throw error ?? new Error('No response')
      setCampaignId(res.campaign_id)
      if (res.items.length === 0) {
        toast.info('No posts found. Try different keywords or subreddits.')
        return
      }
      setItems(res.items.map((item: CampaignItem) => ({ ...item, selected: true, editedDraft: item.draft })))
      setStep('review')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to generate drafts')
    } finally {
      setDiscovering(false)
    }
  }

  async function handlePost() {
    if (!campaignId) return
    const selected = items.filter((i) => i.selected)
    if (selected.length === 0) { toast.error('Select at least one to post'); return }
    setExecuting(true)
    try {
      const finalComments = Object.fromEntries(selected.map((i) => [i.id, i.editedDraft]))
      const { data: res, error } = await executeCommentCampaign({
        campaign_id: campaignId,
        item_ids: selected.map((i) => i.id),
        final_comments: finalComments,
      })
      if (error || !res) throw error ?? new Error('No response')
      setDoneResult({ posted: res.posted, failed: res.failed })
      setStep('done')
      qc.invalidateQueries({ queryKey: ['social-comments'] })
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to post comments')
    } finally {
      setExecuting(false)
    }
  }

  function handleClose() {
    onOpenChange(false)
    setTimeout(reset, 300)
  }

  const selectedCount = items.filter((i) => i.selected).length

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {step === 'targeting' && 'New comment campaign'}
            {step === 'review' && (
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => setStep('targeting')} className="text-gray-400 hover:text-gray-600">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                Review & approve comments
              </span>
            )}
            {step === 'done' && 'Campaign complete'}
          </DialogTitle>
        </DialogHeader>

        {step === 'targeting' && (
          <div className="space-y-4 pt-1 overflow-y-auto flex-1">

            {/* Channel selector */}
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <div className="flex gap-2">
                {(['reddit', 'linkedin', 'twitter'] as Channel[]).map((c) => {
                  const { label, Icon } = CHANNEL_META[c]
                  const isConnected = connectedSlugs.has(c)
                  const isActive = channel === c
                  return (
                    <button
                      key={c}
                      type="button"
                      disabled={!isConnected}
                      title={!isConnected ? `Connect ${label} in Settings first` : undefined}
                      onClick={() => setChannel(c)}
                      className={`flex items-center gap-1.5 rounded border px-3 py-1.5 text-sm transition ${
                        isActive
                          ? 'border-blue-500 bg-blue-50 text-blue-800 font-medium'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      } ${!isConnected ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Campaign name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. CRM discussions — July" />
            </div>

            {channel === 'reddit' ? (
              <>
                <div className="space-y-1.5">
                  <Label>Keywords</Label>
                  <Input
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="e.g. CRM software, sales automation"
                  />
                  <p className="text-[11px] text-gray-400">Search terms to find relevant Reddit posts.</p>
                </div>

                <div className="space-y-1.5">
                  <Label>Subreddits <span className="text-gray-400 font-normal">(optional, comma-separated)</span></Label>
                  <Input
                    value={subreddits}
                    onChange={(e) => setSubreddits(e.target.value)}
                    placeholder="e.g. SaaS, startups, CRM"
                  />
                  <p className="text-[11px] text-gray-400">Limit search to specific subreddits. Leave blank to search all of Reddit.</p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Sort by</Label>
                    <Select value={sort} onValueChange={(v) => setSort(v as 'relevance' | 'hot' | 'new' | 'top')}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SORT_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Posts to find</Label>
                    <Input
                      type="number"
                      min={1}
                      max={25}
                      value={postCount}
                      onChange={(e) => setPostCount(e.target.value)}
                    />
                  </div>
                </div>
              </>
            ) : channel === 'twitter' ? (
              <div className="space-y-1.5">
                <Label>Tweet URLs <span className="text-gray-400 font-normal">(one per line)</span></Label>
                <Textarea
                  value={postUrlsRaw}
                  onChange={(e) => setPostUrlsRaw(e.target.value)}
                  rows={5}
                  placeholder={'https://x.com/user/status/1234567890\nhttps://twitter.com/user/status/...'}
                  className="text-xs font-mono"
                />
                <p className="text-[11px] text-gray-400">
                  Paste tweet URLs or IDs to reply to. We'll generate a draft reply for each.
                </p>
                {tweetPreviews.length > 0 && (
                  <div className="space-y-1 mt-1">
                    {tweetPreviews.map(({ url, parsed }, i) => (
                      <div key={i} className="text-[11px]">
                        {parsed.warning
                          ? <span className="text-amber-600">⚠ {url.slice(0, 70)} — {parsed.warning}</span>
                          : <span className="text-gray-400 font-mono block truncate">✓ {parsed.id}</span>
                        }
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Post URLs <span className="text-gray-400 font-normal">(one per line)</span></Label>
                <Textarea
                  value={postUrlsRaw}
                  onChange={(e) => setPostUrlsRaw(e.target.value)}
                  rows={5}
                  placeholder={
                    'https://www.linkedin.com/posts/username_ugcPost-1234567890-ABCD\nhttps://www.linkedin.com/feed/update/urn:li:ugcPost:...'
                  }
                  className="text-xs font-mono"
                />
                <p className="text-[11px] text-gray-400">
                  Use ··· → "Copy link" on each post. We'll fetch the post content and auto-draft a comment for each.
                  Activity URLs are not supported.
                </p>
                {urlLines.length > 0 && (
                  <div className="space-y-1 mt-1">
                    {linkedInPreviews.map(({ url, parsed }, i) => (
                      <div key={i} className="text-[11px]">
                        {parsed.warning
                          ? <span className="text-amber-600">⚠ {url.slice(0, 70)} — {parsed.warning}</span>
                          : <span className="text-gray-400 font-mono block truncate">✓ {parsed.urn}</span>
                        }
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Tone</Label>
                <Input value={tone} onChange={(e) => setTone(e.target.value)} placeholder="professional and genuine" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Persona / instructions</Label>
              <Textarea
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                rows={3}
                placeholder={channel === 'reddit'
                  ? 'e.g. You represent butterbaseCRM. Comment helpfully on posts about CRM tools — mention butterbase only when directly relevant.'
                  : channel === 'twitter'
                  ? 'e.g. You represent butterbaseCRM. Reply concisely and add value — keep it under 280 characters.'
                  : 'e.g. You represent butterbaseCRM. Write insightful comments that contribute to the conversation and build brand credibility.'}
              />
              <p className="text-[11px] text-gray-400">Guides the AI when drafting comments. The more specific, the better.</p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
              <Button
                type="button"
                size="sm"
                disabled={discovering || !canDiscover}
                onClick={handleDiscover}
                className="bg-foreground text-background hover:bg-foreground/85"
              >
                {discovering
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Finding posts…</>
                  : 'Find posts & generate drafts'}
              </Button>
            </div>
          </div>
        )}

        {step === 'review' && (
          <>
            <div className="flex items-center justify-between text-xs text-gray-500 pb-1">
              <span>{items.length} post{items.length !== 1 ? 's' : ''} · {selectedCount} selected</span>
              <div className="flex gap-2">
                <button type="button" className="hover:text-gray-800" onClick={() => setItems((p) => p.map((i) => ({ ...i, selected: true })))}>Select all</button>
                <span>·</span>
                <button type="button" className="hover:text-gray-800" onClick={() => setItems((p) => p.map((i) => ({ ...i, selected: false })))}>None</button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 space-y-3 pr-1">
              {items.map((item, idx) => {
                const postHref = channel === 'reddit'
                  ? `https://www.reddit.com/comments/${item.target_post_id.replace('t3_', '')}`
                  : channel === 'twitter'
                  ? `https://x.com/i/status/${item.target_post_id}`
                  : `https://www.linkedin.com/feed/update/${item.target_post_id}`
                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-3 space-y-2 transition-colors ${item.selected ? 'border-gray-300 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={item.selected}
                        onChange={(e) => setItems((p) => p.map((i, j) => j === idx ? { ...i, selected: e.target.checked } : i))}
                        className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs text-gray-700 font-medium truncate">{item.title !== item.target_post_id ? item.title : item.target_post_id}</p>
                          <a href={postHref} target="_blank" rel="noopener noreferrer" className="shrink-0 text-blue-500 hover:text-blue-600">
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                        {item.title !== item.target_post_id && (
                          <p className="text-[10px] text-gray-400 font-mono truncate">{item.target_post_id}</p>
                        )}
                      </div>
                    </div>
                    <Textarea
                      value={item.editedDraft}
                      onChange={(e) => setItems((p) => p.map((i, j) => j === idx ? { ...i, editedDraft: e.target.value } : i))}
                      rows={3}
                      className="text-xs resize-none"
                      placeholder="Edit AI draft…"
                    />
                  </div>
                )
              })}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 mt-1">
              <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
              <Button
                type="button"
                size="sm"
                disabled={executing || selectedCount === 0}
                onClick={handlePost}
                className="bg-foreground text-background hover:bg-foreground/85"
              >
                {executing
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Posting…</>
                  : `Post ${selectedCount} comment${selectedCount !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </>
        )}

        {step === 'done' && doneResult && (
          <div className="py-6 flex flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-2">
              {doneResult.posted > 0 && (
                <div className="flex items-center gap-2 text-green-600">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">{doneResult.posted} comment{doneResult.posted !== 1 ? 's' : ''} posted</span>
                </div>
              )}
              {doneResult.failed > 0 && (
                <div className="flex items-center gap-2 text-red-600">
                  <XCircle className="h-5 w-5" />
                  <span className="font-medium">{doneResult.failed} failed — check comments tab for details</span>
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={reset}>New campaign</Button>
              <Button type="button" size="sm" onClick={handleClose} className="bg-foreground text-background hover:bg-foreground/85">Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
