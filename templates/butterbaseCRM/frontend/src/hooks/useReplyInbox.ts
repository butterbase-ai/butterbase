import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listReplyInbox, replyToInboxItem, type ReplyInboxItem } from '../lib/socialApi'
import { useCurrentWorkspaceId } from '../lib/workspace'

export type { ReplyInboxItem }

export function useReplyInbox() {
  const ws = useCurrentWorkspaceId()
  return useQuery({
    enabled: !!ws,
    queryKey: ['reply-inbox', ws],
    queryFn: () => listReplyInbox(ws!),
  })
}

export function useReplyToInboxItem() {
  const qc = useQueryClient()
  const ws = useCurrentWorkspaceId()
  return useMutation({
    mutationFn: ({ inbox_item_id, body }: { inbox_item_id: string; body: string }) =>
      replyToInboxItem(inbox_item_id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reply-inbox', ws] }),
  })
}
