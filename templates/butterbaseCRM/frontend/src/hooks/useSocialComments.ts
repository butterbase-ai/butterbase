import { useQuery } from '@tanstack/react-query'
import { listSocialComments, type SocialComment } from '../lib/socialApi'
import { useCurrentWorkspaceId } from '../lib/workspace'

export type { SocialComment }

export function useSocialComments() {
  const ws = useCurrentWorkspaceId()
  return useQuery({
    enabled: !!ws,
    queryKey: ['social-comments', ws],
    queryFn: () => listSocialComments(ws!),
  })
}
