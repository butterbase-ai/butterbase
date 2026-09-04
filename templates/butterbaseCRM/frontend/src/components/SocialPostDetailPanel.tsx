import { useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { Loader2, ExternalLink, Trash2, RotateCw, XCircle, Pencil, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { deleteFromPlatform, cloneSocialPost } from '@/lib/socialApi'
import type { SocialPost, SocialPostSend } from '@/lib/socialApi'
import type { SocialPostWithSends } from '@/hooks/useSocialPosts'
import { useRetrySocialPost } from '@/hooks/useRetrySocialPost'
import { useCancelSocialPost, useDeleteSocialPost } from '@/hooks/useCancelSocialPost'
import { SOCIAL_ICONS } from '@/components/SocialIcons'
import { SocialPostComposer } from '@/components/SocialPostComposer'

function statusPill(status: string) {
  const map: Record<string, { dot: string; label: string }> = {
    draft: { dot: 'bg-gray-400', label: 'text-gray-600' },
    scheduled: { dot: 'bg-blue-500', label: 'text-blue-700' },
    sending: { dot: 'bg-blue-400', label: 'text-blue-700' },
    sent: { dot: 'bg-green-500', label: 'text-green-700' },
    partial: { dot: 'bg-amber-500', label: 'text-amber-700' },
    failed: { dot: 'bg-red-500', label: 'text-red-700' },
    canceled: { dot: 'bg-gray-300', label: 'text-gray-500' },
    pending: { dot: 'bg-gray-300', label: 'text-gray-500' },
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
  post: SocialPostWithSends
  onClose?: () => void
}

export function SocialPostDetailPanel({ post, onClose }: Props) {
  const retry = useRetrySocialPost()
  const cancel = useCancelSocialPost()
  const del = useDeleteSocialPost()
  const qc = useQueryClient()

  const [composerOpen, setComposerOpen] = useState(false)
  const [composerPost, setComposerPost] = useState<SocialPost | null>(null)
  const [reposting, setReposting] = useState(false)

  const hasFailed = post.sends.some((s) => s.status === 'failed')
  const canCancel = post.status === 'scheduled'
  const canEdit = post.status !== 'sending'
  const isDraft = post.status === 'draft'

  function handleEdit() {
    setComposerPost(post)
    setComposerOpen(true)
  }

  async function handleRepost() {
    setReposting(true)
    try {
      const { data, error } = await cloneSocialPost(post.id)
      if (error) throw new Error(typeof error === 'string' ? error : (error?.error ?? error?.message ?? 'Repost failed'))
      qc.invalidateQueries({ queryKey: ['social-posts'] })
      // Open the fresh draft (same content, new id) for tweaking + publishing.
      setComposerPost({ ...post, id: data!.id, status: 'draft', scheduled_at: null, published_at: null })
      setComposerOpen(true)
      toast.success('Cloned to a draft — edit & publish')
    } catch (e: any) {
      toast.error(e?.message ?? 'Repost failed')
    } finally {
      setReposting(false)
    }
  }

  async function handleRetry() {
    try {
      await retry.mutateAsync(post.id)
      toast.success('Retrying failed channels…')
    } catch (e: any) {
      toast.error(e?.message ?? 'Retry failed')
    }
  }

  async function handleCancel() {
    try {
      await cancel.mutateAsync(post.id)
      toast.success('Scheduled post canceled')
    } catch (e: any) {
      toast.error(e?.message ?? 'Cancel failed')
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this post? This only removes the local record; published posts stay on each platform.')) return
    try {
      await del.mutateAsync(post.id)
      toast.success('Post deleted')
      onClose?.()
    } catch (e: any) {
      toast.error(e?.message ?? 'Delete failed')
    }
  }

  const when = post.published_at
    ? `Published ${formatDistanceToNowStrict(new Date(post.published_at), { addSuffix: true })}`
    : post.scheduled_at
      ? `Scheduled for ${new Date(post.scheduled_at).toLocaleString()}`
      : `Created ${formatDistanceToNowStrict(new Date(post.created_at), { addSuffix: true })}`

  return (
    <>
    <aside className="border-l border-gray-200 bg-gray-50 p-4 space-y-4 overflow-y-auto">
      <header className="space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div>{statusPill(post.status)}</div>
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
        <div className="text-xs text-gray-500">{when}</div>
      </header>

      <div className="rounded border border-gray-200 bg-white p-3 text-xs text-gray-700 whitespace-pre-wrap">
        {post.body}
        {post.link_url && <div className="mt-2 text-blue-600 break-all">{post.link_url}</div>}
      </div>

      <div>
        <div className="eyebrow !text-[10px] mb-2">Per-channel results</div>
        <div className="space-y-1">
          {post.sends.length === 0 && (
            <div className="text-xs text-gray-500">No sends recorded yet.</div>
          )}
          {post.sends.map((send) => <SendRow key={send.id} send={send} />)}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
        {canEdit && (
          <Button size="sm" variant="outline" onClick={handleEdit} className="text-xs">
            <Pencil className="h-3 w-3" />
            {isDraft ? 'Edit & publish' : 'Edit'}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={handleRepost} disabled={reposting} className="text-xs">
          {reposting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
          Repost
        </Button>
        {hasFailed && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={retry.isPending}
            className="text-xs"
          >
            {retry.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCw className="h-3 w-3" />}
            Retry failed
          </Button>
        )}
        {canCancel && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleCancel}
            disabled={cancel.isPending}
            className="text-xs text-amber-700"
          >
            {cancel.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
            Cancel schedule
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={handleDelete}
          disabled={del.isPending}
          className="text-xs text-red-600"
        >
          {del.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Delete
        </Button>
      </div>
    </aside>
    <SocialPostComposer open={composerOpen} onOpenChange={setComposerOpen} post={composerPost} />
    </>
  )
}

function SendRow({ send }: { send: SocialPostSend }) {
  const qc = useQueryClient()
  const [removing, setRemoving] = useState(false)

  async function handleRemoveFromPlatform() {
    if (!send.external_post_id) return
    if (!confirm(`Delete this post from ${send.channel}? This removes it from the platform (irreversible).`)) return
    setRemoving(true)
    try {
      const { data, error } = await deleteFromPlatform(send.id)
      if (error) {
        toast.error(typeof error === 'string' ? error : (error?.error ?? error?.message ?? 'Failed'))
      } else if (data?.note) {
        toast.info(data.note)
        qc.invalidateQueries({ queryKey: ['social-posts'] })
      } else if (data?.ok === false && data?.error) {
        toast.info(data.error)
        qc.invalidateQueries({ queryKey: ['social-posts'] })
      } else {
        toast.success(`Removed from ${send.channel}`)
        qc.invalidateQueries({ queryKey: ['social-posts'] })
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="rounded border border-gray-200 bg-white p-2 space-y-1">
      <div className="flex items-center gap-2 text-xs">
        {(() => { const Icon = SOCIAL_ICONS[send.channel]; return <Icon className="h-4 w-4 shrink-0" /> })()}
        <span className="flex-1 capitalize">{send.channel}</span>
        {statusPill(send.status)}
        {send.external_url && (
          <a
            href={send.external_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 hover:underline flex items-center gap-0.5"
          >
            view <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {send.error && (
        <div className="rounded bg-red-50 border border-red-200 px-2 py-1 text-[11px] text-red-700">
          <b>Error:</b> {send.error}
        </div>
      )}
      <div className="flex items-center gap-2 text-[10px] text-gray-400">
        {send.attempts > 0 && <span>Attempts: {send.attempts}</span>}
        {send.external_post_id && (
          <button
            type="button"
            onClick={handleRemoveFromPlatform}
            disabled={removing}
            className="ml-auto text-gray-500 hover:text-red-600 underline decoration-dotted disabled:opacity-50"
          >
            {removing ? 'removing…' : 'remove from platform'}
          </button>
        )}
      </div>
    </div>
  )
}
