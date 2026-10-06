import { useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ExternalLink, Loader2, RotateCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { retrySocialComment, deleteSocialComment } from '@/lib/socialApi'
import type { SocialComment, SocialChannel } from '@/lib/socialApi'
import { SOCIAL_ICONS } from '@/components/SocialIcons'

function statusPill(status: string) {
  const map: Record<string, { dot: string; label: string }> = {
    pending: { dot: 'bg-yellow-400', label: 'text-yellow-700' },
    sent:    { dot: 'bg-green-500',  label: 'text-green-700' },
    failed:  { dot: 'bg-red-500',    label: 'text-red-700' },
  }
  const m = map[status] ?? { dot: 'bg-gray-300', label: 'text-gray-500' }
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${m.label}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {status}
    </span>
  )
}

interface Props {
  comment: SocialComment
  onClose?: () => void
}

export function SocialCommentDetailPanel({ comment, onClose }: Props) {
  const qc = useQueryClient()
  const Icon = SOCIAL_ICONS[comment.channel as SocialChannel]
  const when = comment.created_at
    ? formatDistanceToNowStrict(new Date(comment.created_at), { addSuffix: true })
    : '—'

  const retry = useMutation({
    mutationFn: () => retrySocialComment(comment.id),
    onSuccess: () => {
      toast.success('Retrying comment…')
      qc.invalidateQueries({ queryKey: ['social-comments'] })
    },
    onError: (e: any) => toast.error(e?.message ?? 'Retry failed'),
  })

  const [deleting, setDeleting] = useState(false)
  async function handleDelete() {
    if (!confirm('Delete this comment record? This only removes the local record; the comment stays on the platform if it was posted.')) return
    setDeleting(true)
    try {
      await deleteSocialComment(comment.id)
      toast.success('Comment deleted')
      onClose?.()
      qc.invalidateQueries({ queryKey: ['social-comments'] })
    } catch (e: any) {
      toast.error(e?.message ?? 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <aside className="border-l border-gray-200 bg-gray-50 p-4 space-y-4 overflow-y-auto">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div>{statusPill(comment.status)}</div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
              aria-label="Close panel"
            >
              ✕
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Icon className="h-3.5 w-3.5" />
          <span className="capitalize">{comment.channel}</span>
          <span>·</span>
          <span>{when}</span>
        </div>
      </header>

      {comment.target_post_url && (
        <div>
          <div className="eyebrow !text-[10px] mb-1">Target post</div>
          <a
            href={comment.target_post_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline break-all"
          >
            {comment.target_post_url}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
        </div>
      )}

      <div className="rounded border border-gray-200 bg-white p-3 text-xs text-gray-700 whitespace-pre-wrap">
        {comment.body}
      </div>

      {comment.status === 'failed' && comment.error && (
        <div className="rounded bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          <div className="font-semibold mb-0.5">Error</div>
          {comment.error}
        </div>
      )}

      {(comment.external_url || comment.external_comment_id) && (
        <div>
          <div className="eyebrow !text-[10px] mb-1">Live comment</div>
          <div className="rounded border border-gray-200 bg-white p-2 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 capitalize">{comment.channel}</span>
              {statusPill(comment.status)}
              {comment.external_url && (
                <a
                  href={comment.external_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline flex items-center gap-0.5"
                >
                  view <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            {comment.external_comment_id && (
              <div className="text-[10px] text-gray-400">ID: {comment.external_comment_id}</div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
        {comment.status === 'failed' && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            className="text-xs"
          >
            {retry.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
            Retry
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs text-red-600"
        >
          {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Delete
        </Button>
      </div>
    </aside>
  )
}
