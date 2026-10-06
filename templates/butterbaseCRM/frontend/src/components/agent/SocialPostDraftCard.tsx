import { useState } from 'react'
import { Sparkles, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SOCIAL_ICONS } from '@/components/SocialIcons'
import { SocialPostComposer } from '@/components/SocialPostComposer'
import type { ChannelOverrides, SocialChannel } from '@/lib/socialApi'

interface DraftPayload {
  channels: SocialChannel[]
  body: string
  overrides: ChannelOverrides
  rationale?: string | null
}

function bodyFor(payload: DraftPayload, channel: SocialChannel): string {
  const co = payload.overrides?.[channel] as { body?: string; caption?: string } | undefined
  const ov = co?.body ?? co?.caption
  return (typeof ov === 'string' && ov.length > 0) ? ov : payload.body
}

export function SocialPostDraftCard({ payload, onDismiss }: { payload: DraftPayload; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false)
  const channels = payload.channels ?? []

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-900">
        <Sparkles className="h-3.5 w-3.5" /> AI draft — review before posting
      </div>
      {payload.rationale && <p className="text-[12px] text-violet-800/80 italic">{payload.rationale}</p>}

      <div className="space-y-1.5">
        {channels.map((ch) => {
          const Icon = SOCIAL_ICONS[ch]
          const reddit = ch === 'reddit' ? payload.overrides?.reddit : undefined
          return (
            <div key={ch} className="rounded border border-violet-200 bg-white p-2 space-y-1">
              <div className="flex items-center gap-1.5 text-[11px] font-medium capitalize text-gray-700">
                <Icon className="h-3.5 w-3.5" /> {ch}
              </div>
              {reddit && (
                <div className="text-[11px] text-gray-600">
                  <span className="font-medium">{reddit.title || '(no title)'}</span>
                  {' · '}
                  <span className="text-orange-700">r/{reddit.subreddit || '?'}</span>
                  <span className="text-gray-400"> — verify</span>
                </div>
              )}
              <p className="text-[12px] text-gray-700 whitespace-pre-wrap line-clamp-4">{bodyFor(payload, ch)}</p>
            </div>
          )
        })}
      </div>

      <div className="flex gap-2 pt-0.5">
        <Button size="sm" className="text-xs" onClick={() => setOpen(true)}>
          <Send className="h-3 w-3" /> Review &amp; publish
        </Button>
        {onDismiss && (
          <Button size="sm" variant="ghost" className="text-xs text-gray-500" onClick={onDismiss}>
            <X className="h-3 w-3" /> Dismiss
          </Button>
        )}
      </div>

      <SocialPostComposer
        open={open}
        onOpenChange={setOpen}
        initialContent={{ body: payload.body, channels, channel_overrides: payload.overrides }}
      />
    </div>
  )
}
