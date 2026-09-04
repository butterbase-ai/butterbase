import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createSocialPost, type CreatePayload, type CreateResult } from '../lib/socialApi'

export function useCreateSocialPost() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (payload: CreatePayload): Promise<CreateResult> => {
      const { data, error } = await createSocialPost(payload)
      if (error) {
        const message = typeof error === 'string'
          ? error
          : (error?.error ?? error?.message ?? 'Failed to create social post')
        const wrapped = new Error(message)
        ;(wrapped as any).cause = error
        throw wrapped
      }
      if (!data) throw new Error('No response from create-social-post')
      return data
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['social-posts'] })
    },
  })
}
