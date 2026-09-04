import { useMutation, useQueryClient } from '@tanstack/react-query'
import { retrySocialPost } from '../lib/socialApi'

export function useRetrySocialPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (post_id: string) => {
      const { data, error } = await retrySocialPost(post_id)
      if (error) throw new Error(typeof error === 'string' ? error : (error?.error ?? error?.message ?? 'Retry failed'))
      return data
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['social-posts'] }),
  })
}
