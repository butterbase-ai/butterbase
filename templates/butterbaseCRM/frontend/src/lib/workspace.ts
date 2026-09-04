import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WS {
  workspaceId: string | null;
  setWorkspace: (id: string | null) => void;
}

export const useWorkspaceStore = create<WS>()(
  persist(
    (set) => ({ workspaceId: null, setWorkspace: (id) => set({ workspaceId: id }) }),
    { name: 'crm.workspace' },
  ),
);

export function useCurrentWorkspaceId(): string {
  const id = useWorkspaceStore((s) => s.workspaceId);
  if (!id) throw new Error('No active workspace');
  return id;
}
