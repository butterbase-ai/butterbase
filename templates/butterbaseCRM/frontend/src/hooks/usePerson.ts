import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';
import type { Person } from '@/lib/types';
import { getEntity, entityToPerson } from '@/lib/substrate';

export function usePerson(id: string) {
  return useQuery<Person>({
    queryKey: qk.person(id),
    queryFn: async () => {
      const entity = await getEntity(id);
      if (!entity) return {} as Person;
      return entityToPerson(entity);
    },
    enabled: !!id,
  });
}
