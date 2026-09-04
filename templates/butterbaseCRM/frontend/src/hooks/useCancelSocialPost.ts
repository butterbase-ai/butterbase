import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cancelScheduledPost, deleteSocialPost } from '../lib/socialApi'

export function useCancelSocialPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: cancelScheduledPost,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['social-posts'] }),
  })
}

export function useDeleteSocialPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteSocialPost,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['social-posts'] }),
  })
}
