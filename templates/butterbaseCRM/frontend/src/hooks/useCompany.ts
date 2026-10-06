import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import type { Company } from '@/lib/types';
import { getEntity, entityToCompany } from '@/lib/substrate';

export function useCompany(id: string) {
  return useQuery<Company>({
    queryKey: qk.company(id),
    queryFn: async () => {
      const entity = await getEntity(id);
      if (!entity) return {} as Company;
      return entityToCompany(entity);
    },
    enabled: !!id,
  });
}
