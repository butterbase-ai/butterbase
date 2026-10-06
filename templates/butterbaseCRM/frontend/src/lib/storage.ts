import { useQuery } from '@tanstack/react-query';
import { bb } from './butterbase';

export function useDownloadUrl(objectId: string | null | undefined) {
  return useQuery({
    queryKey: ['downloadUrl', objectId],
    queryFn: async () => {
      if (!objectId) return null;
      const { data, error } = await bb.storage.getDownloadUrl(objectId);
      if (error) throw error;
      return data?.url ?? null;
    },
    enabled: !!objectId,
    staleTime: 50 * 60 * 1000,
  });
}

export async function uploadFile(file: File, opts?: { public?: boolean }) {
  // SDK signature: upload(file, filename?, { public? })
  const { data, error } = await bb.storage.upload(file, file.name, { public: opts?.public ?? false });
  if (error) throw error;
  return data; // { objectId, objectKey }
}
