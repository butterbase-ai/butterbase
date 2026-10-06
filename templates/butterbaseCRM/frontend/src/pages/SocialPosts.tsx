import { useMemo, useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { ExternalLink, MessageSquare, Inbox } from 'lucide-react'
import { NewSocialPostDialog } from '@/components/NewSocialPostDialog'
import { CommentCampaignDialog } from '@/components/CommentCampaignDialog'
import { SocialPostDetailPanel } from '@/components/SocialPostDetailPanel'
import { SocialCommentDetailPanel } from '@/components/SocialCommentDetailPanel'
import { useSocialPosts, type SocialPostWithSends } from '@/hooks/useSocialPosts'
import { useSocialComments, type SocialComment } from '@/hooks/useSocialComments'
import { useReplyInbox, useReplyToInboxItem, type ReplyInboxItem } from '@/hooks/useReplyInbox'
import { NewSocialCommentDialog } from '@/components/NewSocialCommentDialog'
import type { SocialChannel, SocialPostStatus } from '@/lib/socialApi'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SOCIAL_ICONS } from '@/components/SocialIcons'

const STATUS_FILTERS: (SocialPostStatus | 'all')[] = ['all', 'draft', 'scheduled', 'sent', 'partial', 'failed']
const CHANNEL_FILTERS: SocialChannel[] = ['twitter', 'linkedin', 'reddit']
const COMMENT_CHANNEL_FILTERS: ('reddit' | 'linkedin' | 'twitter')[] = ['reddit', 'linkedin', 'twitter']

type View = 'posts' | 'comments' | 'inbox'

function statusDot(status: string) {
  const map: Record<string, string> = {
    draft: 'bg-gray-400',
    scheduled: 'bg-blue-500',
    sending: 'bg-blue-400',
    sent: 'bg-green-500',
    partial: 'bg-amber-500',
    failed: 'bg-red-500',
    canceled: 'bg-gray-300',
    pending: 'bg-yellow-400',
  }
  return map[status] ?? 'bg-gray-300'
}

export default function SocialPosts() {
  const [view, setView] = useState<View>('posts')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [campaignOpen, setCampaignOpen] = useState(false)

  // Posts state
  const { data: posts = [], isLoading: postsLoading } = useSocialPosts()
  const [statusFilter, setStatusFilter] = useState<typeof STATUS_FILTERS[number]>('all')
  const [channelFilter, setChannelFilter] = useState<SocialChannel | null>(null)

  // Comments state
  const { data: comments = [], isLoading: commentsLoading } = useSocialComments()
  const [commentChannelFilter, setCommentChannelFilter] = useState<'reddit' | 'linkedin' | 'twitter' | null>(null)

  // Inbox state
  const { data: inboxItems = [], isLoading: inboxLoading } = useReplyInbox()

  const filteredPosts = useMemo(() => posts.filter((p) => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false
    if (channelFilter && !p.channels.includes(channelFilter)) return false
    if (search.trim() && !p.body.toLowerCase().includes(search.trim().toLowerCase())) return false
    return true
  }), [posts, statusFilter, channelFilter, search])

  const filteredComments = useMemo(() => comments.filter((c) => {
    if (commentChannelFilter && c.channel !== commentChannelFilter) return false
    if (search.trim() && !c.body.toLowerCase().includes(search.trim().toLowerCase())) return false
    return true
  }), [comments, commentChannelFilter, search])

  const selectedPost = view === 'posts' && selectedId ? posts.find((p) => p.id === selectedId) ?? null : null
  const selectedComment = view === 'comments' && selectedId ? comments.find((c) => c.id === selectedId) ?? null : null
  const selectedInboxItem = view === 'inbox' && selectedId ? inboxItems.find((i) => i.id === selectedId) ?? null : null
  const selected = selectedPost ?? selectedComment ?? selectedInboxItem

  function switchView(v: View) {
    setView(v)
    setSelectedId(null)
    setSearch('')
  }

  return (
    <>
    <CommentCampaignDialog open={campaignOpen} onOpenChange={setCampaignOpen} />
    <div className="flex h-full">
      <div className={`flex-1 flex flex-col ${selected ? 'border-r border-gray-200' : ''}`}>
        {/* Toolbar */}
        <div className="flex items-center gap-3 border-b border-gray-200 px-6 py-4">
          <h1 className="font-display text-xl tracking-tight flex-1">Social</h1>

          {/* View toggle */}
          <div className="flex rounded-md border border-gray-200 bg-gray-50 p-0.5 text-xs">
            {(['posts', 'comments', 'inbox'] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                className={`rounded px-3 py-1 font-medium capitalize transition-colors ${
                  view === v ? 'bg-white text-foreground shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="w-48 h-9"
          />
          {view === 'comments' ? (
            <div className="flex gap-2">
              <NewSocialCommentDialog />
              <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={() => setCampaignOpen(true)}>
                <MessageSquare className="h-3.5 w-3.5" />
                New campaign
              </Button>
            </div>
          ) : view === 'inbox' ? (
            <div className="flex items-center gap-1.5 text-xs text-gray-500">
              <Inbox className="h-3.5 w-3.5" />
              Reddit replies
            </div>
          ) : <NewSocialPostDialog />}
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-6 py-2.5">
          {view === 'inbox' ? (
            <span className="text-xs text-gray-400">Showing replies to your Reddit posts from the last 30 days</span>
          ) : view === 'posts' ? (
            <>
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`rounded-full border px-3 py-0.5 text-xs ${
                    statusFilter === s
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {s}
                </button>
              ))}
              <span className="text-gray-300">·</span>
              {CHANNEL_FILTERS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setChannelFilter(channelFilter === c ? null : c)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs ${
                    channelFilter === c
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {(() => { const Icon = SOCIAL_ICONS[c]; return <Icon className="h-3 w-3" /> })()}
                  {c}
                </button>
              ))}
            </>
          ) : (
            <>
              {(['all', 'sent', 'failed', 'pending'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {}}
                  className="rounded-full border px-3 py-0.5 text-xs border-gray-200 bg-white text-gray-400 cursor-default"
                >
                  {s}
                </button>
              ))}
              <span className="text-gray-300">·</span>
              {COMMENT_CHANNEL_FILTERS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCommentChannelFilter(commentChannelFilter === c ? null : c)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs ${
                    commentChannelFilter === c
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {(() => { const Icon = SOCIAL_ICONS[c as SocialChannel]; return <Icon className="h-3 w-3" /> })()}
                  {c}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {view === 'posts' ? (
            postsLoading ? (
              <div className="px-6 py-10 text-sm text-gray-500">Loading…</div>
            ) : filteredPosts.length === 0 ? (
              <div className="px-6 py-10 text-sm text-gray-500">
                {posts.length === 0 ? 'No posts yet. Click "New post" to get started.' : 'No posts match these filters.'}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                    <th className="px-6 py-2 font-semibold">Post</th>
                    <th className="px-2 py-2 font-semibold">Channels</th>
                    <th className="px-2 py-2 font-semibold">When</th>
                    <th className="px-2 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPosts.map((p) => (
                    <PostRow
                      key={p.id}
                      post={p}
                      selected={p.id === selectedId}
                      onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}
                    />
                  ))}
                </tbody>
              </table>
            )
          ) : view === 'inbox' ? (
            inboxLoading ? (
              <div className="px-6 py-10 text-sm text-gray-500">Loading…</div>
            ) : inboxItems.length === 0 ? (
              <div className="px-6 py-10 text-sm text-gray-500">
                No replies yet. Replies to your Reddit posts will appear here automatically.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                    <th className="px-6 py-2 font-semibold">Reply</th>
                    <th className="px-2 py-2 font-semibold">From</th>
                    <th className="px-2 py-2 font-semibold">Score</th>
                    <th className="px-2 py-2 font-semibold">When</th>
                    <th className="px-2 py-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {inboxItems.map((item) => (
                    <InboxRow
                      key={item.id}
                      item={item}
                      selected={item.id === selectedId}
                      onClick={() => setSelectedId(item.id === selectedId ? null : item.id)}
                    />
                  ))}
                </tbody>
              </table>
            )
          ) : (
            commentsLoading ? (
              <div className="px-6 py-10 text-sm text-gray-500">Loading…</div>
            ) : filteredComments.length === 0 ? (
              <div className="px-6 py-10 text-sm text-gray-500">
                {comments.length === 0 ? 'No comments yet. Click "New comment" to get started.' : 'No comments match these filters.'}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-200">
                    <th className="px-6 py-2 font-semibold">Comment</th>
                    <th className="px-2 py-2 font-semibold">Channel</th>
                    <th className="px-2 py-2 font-semibold">When</th>
                    <th className="px-2 py-2 font-semibold">Status</th>
                    <th className="px-2 py-2 font-semibold">Link</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredComments.map((c) => (
                    <CommentRow
                      key={c.id}
                      comment={c}
                      selected={c.id === selectedId}
                      onClick={() => setSelectedId(c.id === selectedId ? null : c.id)}
                    />
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>
      </div>

      {selected && (
        <div className="w-[380px] shrink-0">
          {selectedPost && (
            <SocialPostDetailPanel post={selectedPost} onClose={() => setSelectedId(null)} />
          )}
          {selectedComment && (
            <SocialCommentDetailPanel comment={selectedComment} onClose={() => setSelectedId(null)} />
          )}
          {selectedInboxItem && (
            <InboxDetailPanel item={selectedInboxItem} onClose={() => setSelectedId(null)} />
          )}
        </div>
      )}
    </div>
    </>
  )
}

function PostRow({ post, selected, onClick }: { post: SocialPostWithSends; selected: boolean; onClick: () => void }) {
  const when = post.published_at
    ? formatDistanceToNowStrict(new Date(post.published_at), { addSuffix: true })
    : post.scheduled_at
      ? new Date(post.scheduled_at).toLocaleString()
      : '—'

  return (
    <tr
      onClick={onClick}
      className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${selected ? 'bg-blue-50/50' : ''}`}
    >
      <td className="px-6 py-3 max-w-[420px] truncate text-gray-800">{post.body}</td>
      <td className="px-2 py-3 text-xs">
        {post.channels.map((c) => {
          const Icon = SOCIAL_ICONS[c]
          return (
            <span key={c} className="mr-1 inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5">
              <Icon className="h-4 w-4" />
            </span>
          )
        })}
      </td>
      <td className="px-2 py-3 text-xs text-gray-500">{when}</td>
      <td className="px-2 py-3 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className={`h-1.5 w-1.5 rounded-full ${statusDot(post.status)}`} />
          {post.status}
        </span>
      </td>
    </tr>
  )
}

function InboxRow({ item, selected, onClick }: { item: ReplyInboxItem; selected: boolean; onClick: () => void }) {
  const when = formatDistanceToNowStrict(new Date(item.created_at), { addSuffix: true })

  return (
    <tr onClick={onClick} className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${selected ? 'bg-blue-50/50' : ''}`}>
      <td className="px-6 py-3 max-w-[380px] text-gray-800">
        <p className="truncate">{item.body}</p>
        {item.external_url && (
          <p className="text-[11px] text-gray-400 truncate mt-0.5">{item.external_url}</p>
        )}
      </td>
      <td className="px-2 py-3 text-xs text-gray-600">{item.author_name ?? '—'}</td>
      <td className="px-2 py-3 text-xs text-gray-500">{item.score}</td>
      <td className="px-2 py-3 text-xs text-gray-500">{when}</td>
      <td className="px-2 py-3 text-xs">
        {item.replied_at ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-green-700 font-medium">
            Replied
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-yellow-50 px-2 py-0.5 text-yellow-700">
            Pending
          </span>
        )}
      </td>
    </tr>
  )
}

function InboxDetailPanel({ item, onClose }: { item: ReplyInboxItem; onClose: () => void }) {
  const [replyText, setReplyText] = useState('')
  const replyMutation = useReplyToInboxItem()

  async function handleReply() {
    if (!replyText.trim() || replyMutation.isPending) return
    await replyMutation.mutateAsync({ inbox_item_id: item.id, body: replyText })
    setReplyText('')
  }

  return (
    <div className="flex h-full flex-col border-l border-gray-200 bg-white">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <span className="text-sm font-medium">Reply</span>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-3">
        <div className="rounded-lg bg-gray-50 p-3 text-sm text-gray-700 whitespace-pre-wrap">{item.body}</div>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          {item.author_name && <span>u/{item.author_name}</span>}
          <span>·</span>
          <span>{item.score} pts</span>
          {item.external_url && (
            <>
              <span>·</span>
              <a
                href={item.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-blue-500 hover:underline"
              >
                View on Reddit <ExternalLink className="h-3 w-3" />
              </a>
            </>
          )}
        </div>
      </div>
      <div className="border-t border-gray-200 p-4 space-y-2">
        {item.replied_at ? (
          <p className="text-xs text-green-600">Replied {formatDistanceToNowStrict(new Date(item.replied_at), { addSuffix: true })}</p>
        ) : (
          <>
            <Textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write your reply…"
              className="text-sm resize-none"
              rows={4}
            />
            {replyMutation.isError && (
              <p className="text-xs text-red-500">{String((replyMutation.error as any)?.message ?? 'Failed to post reply')}</p>
            )}
            <Button
              size="sm"
              className="w-full"
              disabled={!replyText.trim() || replyMutation.isPending}
              onClick={handleReply}
            >
              {replyMutation.isPending ? 'Posting…' : 'Post reply'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function CommentRow({ comment, selected, onClick }: { comment: SocialComment; selected: boolean; onClick: () => void }) {
  const when = formatDistanceToNowStrict(new Date(comment.created_at), { addSuffix: true })
  const Icon = SOCIAL_ICONS[comment.channel as SocialChannel]

  return (
    <tr onClick={onClick} className={`cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${selected ? 'bg-blue-50/50' : ''}`}>
      <td className="px-6 py-3 max-w-[420px] text-gray-800">
        <p className="truncate">{comment.body}</p>
        {comment.target_post_url && (
          <p className="text-[11px] text-gray-400 truncate mt-0.5">{comment.target_post_url}</p>
        )}
      </td>
      <td className="px-2 py-3 text-xs">
        <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5">
          <Icon className="h-4 w-4" />
        </span>
      </td>
      <td className="px-2 py-3 text-xs text-gray-500">{when}</td>
      <td className="px-2 py-3 text-xs">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <span className={`h-1.5 w-1.5 rounded-full ${statusDot(comment.status)}`} />
          {comment.status}
          {comment.status === 'failed' && comment.error && (
            <span className="ml-1 text-red-400 font-normal truncate max-w-[160px]" title={comment.error}>
              — {comment.error}
            </span>
          )}
        </span>
      </td>
      <td className="px-2 py-3 text-xs">
        {comment.external_url ? (
          <a
            href={comment.external_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-blue-500 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View <ExternalLink className="h-3 w-3" />
          </a>
        ) : '—'}
      </td>
    </tr>
  )
}
