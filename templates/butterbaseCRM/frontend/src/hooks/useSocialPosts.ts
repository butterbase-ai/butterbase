import { useQuery } from '@tanstack/react-query'
import { listSocialPosts, listSocialPostSends, type SocialPost, type SocialPostSend } from '../lib/socialApi'
import { useCurrentWorkspaceId } from '../lib/workspace'

export interface SocialPostWithSends extends SocialPost {
  sends: SocialPostSend[]
}

export function useSocialPosts() {
  const ws = useCurrentWorkspaceId()
  return useQuery({
    enabled: !!ws,
    queryKey: ['social-posts', ws],
    queryFn: async (): Promise<SocialPostWithSends[]> => {
      const posts = await listSocialPosts(ws!)
      const sends = await listSocialPostSends(posts.map((p) => p.id))
      const byPost = new Map<string, SocialPostSend[]>()
      for (const s of sends) {
        const arr = byPost.get(s.post_id) ?? []
        arr.push(s)
        byPost.set(s.post_id, arr)
      }
      return posts.map((p) => ({ ...p, sends: byPost.get(p.id) ?? [] }))
    },
  })
}
