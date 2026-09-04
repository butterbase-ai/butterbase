import { useState } from 'react'
import { MessageSquare, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { commentOnSocialPost } from '@/lib/socialApi'
import { useCurrentWorkspaceId } from '@/lib/workspace'

type CommentChannel = 'reddit' | 'linkedin'

const CHAR_LIMITS: Record<CommentChannel, number> = {
  reddit: 10000,
  linkedin: 1250,
}

const PLACEHOLDER: Record<CommentChannel, string> = {
  reddit: 'Paste the Reddit post URL',
  linkedin: 'Paste the LinkedIn post URL or feed/update URL',
}

export type LinkedInUrnResult =
  | { urn: string; warning?: undefined }
  | { urn: string; warning: string }

export function extractLinkedInUrn(raw: string): string {
  return parseLinkedInUrn(raw).urn
}

export function parseLinkedInUrn(raw: string): LinkedInUrnResult {
  const trimmed = raw.trim()

  // Already a URN — pass through
  const urnMatch = trimmed.match(/(urn:li:[^/?\s&]+)/i)
  if (urnMatch) {
    const urn = urnMatch[1]
    if (/^urn:li:activity:/i.test(urn)) {
      return { urn, warning: 'Activity URNs are not supported for commenting. Use the post\'s /feed/update/ URL or the ugcPost URL instead.' }
    }
    return { urn }
  }

  // /feed/update/urn:li:share:xxx or /feed/update/urn:li:ugcPost:xxx (most reliable)
  const feedMatch = trimmed.match(/feed\/update\/(urn[^/?#\s&]+)/i)
  if (feedMatch) return { urn: decodeURIComponent(feedMatch[1]) }

  // /posts/slug-ugcPost-{id}-xxxx  → urn:li:ugcPost:{id}
  const ugcMatch = trimmed.match(/\/posts\/[^/?#]*-ugcPost-(\d+)/i)
  if (ugcMatch) return { urn: `urn:li:ugcPost:${ugcMatch[1]}` }

  // /posts/slug-share-{id}-xxxx  → urn:li:share:{id}
  const shareMatch = trimmed.match(/\/posts\/[^/?#]*-share-(\d+)/i)
  if (shareMatch) return { urn: `urn:li:share:${shareMatch[1]}` }

  // /posts/slug-activity-{id}-xxxx — activity ID ≠ post ID, unreliable
  const activityMatch = trimmed.match(/\/posts\/[^/?#]*-activity-(\d+)/i)
  if (activityMatch) {
    return {
      urn: trimmed,
      warning: 'This URL contains an activity ID which cannot be used for comments. Click the ··· menu on the post → "Copy link" to get the ugcPost URL.',
    }
  }

  return { urn: trimmed }
}

function extractTargetId(channel: CommentChannel, raw: string): string {
  const trimmed = raw.trim()
  if (channel === 'reddit') {
    const match = trimmed.match(/comments\/([a-z0-9]+)/i)
    if (match) return `t3_${match[1]}`
    return trimmed
  }
  return parseLinkedInUrn(trimmed).urn
}

export function NewSocialCommentDialog() {
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<CommentChannel>('reddit')
  const [targetRaw, setTargetRaw] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const ws = useCurrentWorkspaceId()

  const limit = CHAR_LIMITS[channel]
  const bodyLen = body.length
  const linkedInParsed = channel === 'linkedin' && targetRaw.trim() ? parseLinkedInUrn(targetRaw) : null
  const hasLinkedInWarning = !!linkedInParsed?.warning

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ws || !targetRaw.trim() || !body.trim()) return
    setSubmitting(true)
    try {
      const target_post_id = extractTargetId(channel, targetRaw)
      const target_post_url = targetRaw.trim().startsWith('http') ? targetRaw.trim() : undefined
      await commentOnSocialPost({ workspace_id: ws, channel, target_post_id, target_post_url, body })
      toast.success('Comment posted!')
      setOpen(false)
      setTargetRaw('')
      setBody('')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to post comment')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-9 gap-1.5"
        onClick={() => setOpen(true)}
      >
        <MessageSquare className="h-3.5 w-3.5" />
        New comment
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New comment</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4 pt-1">
            {/* Channel */}
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <div className="flex gap-2">
                {(['reddit', 'linkedin'] as CommentChannel[]).map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setChannel(c)}
                    className={`flex-1 rounded-md border py-2 text-sm font-medium capitalize transition-colors ${
                      channel === c
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Target post */}
            <div className="space-y-1.5">
              <Label>Post URL or ID</Label>
              <Input
                value={targetRaw}
                onChange={(e) => setTargetRaw(e.target.value)}
                placeholder={PLACEHOLDER[channel]}
                className="text-xs"
              />
              {channel === 'linkedin' && (() => {
                if (!targetRaw.trim()) return (
                  <p className="text-[11px] text-gray-400 leading-relaxed">
                    Best: use the ··· menu on the post → "Copy link" to get a /posts/…ugcPost… URL
                  </p>
                )
                const parsed = parseLinkedInUrn(targetRaw)
                return (
                  <>
                    {!parsed.warning && (
                      <p className="text-[11px] text-gray-400 font-mono truncate">→ {parsed.urn}</p>
                    )}
                    {parsed.warning && (
                      <p className="text-[11px] text-amber-600 leading-relaxed">{parsed.warning}</p>
                    )}
                  </>
                )
              })()}
            </div>

            {/* Body */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Comment</Label>
                <span className={`text-xs ${bodyLen > limit ? 'text-red-500' : 'text-gray-400'}`}>
                  {bodyLen}/{limit}
                </span>
              </div>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Write your comment…"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={submitting || !targetRaw.trim() || !body.trim() || bodyLen > limit || hasLinkedInWarning}
                className="bg-foreground text-background hover:bg-foreground/85"
              >
                {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Post comment'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
