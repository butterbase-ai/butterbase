import { useQuery } from '@tanstack/react-query'
import { bb } from '../lib/butterbase'

export interface Connection {
  toolkit_slug: string
  status: string
  connected_at?: string
  composio_account_id?: string | null
  // Workspace-shared metadata: present when *any* member has linked this
  // toolkit at the workspace level. The current user may or may not be that
  // member — `is_my_connection` tells them apart.
  connected_by_user_id?: string | null
  is_my_connection?: boolean
}

const SOCIAL = ['twitter', 'linkedin', 'reddit'] as const

interface WorkspaceIntegrationRow {
  toolkit_slug: string
  connected_by_user_id: string
  connected_at: string
  composio_account_id: string | null
}

export function useSocialConnections(workspaceId: string | null) {
  return useQuery({
    queryKey: ['social-connections', workspaceId ?? null],
    queryFn: async (): Promise<Connection[]> => {
      // Workspace-shared view: every member sees the same Connected/Not state
      // because social toolkits run with the original linker's OAuth token.
      let workspaceRows: WorkspaceIntegrationRow[] = []
      let myUserId: string | null = null
      if (workspaceId) {
        const [wRes, meRes] = await Promise.all([
          bb.functions.invoke('list-workspace-integrations', {
            body: { workspace_id: workspaceId, toolkits: [...SOCIAL] },
          }),
          bb.auth.getUser().catch(() => null as any),
        ])
        workspaceRows = ((wRes as any)?.data?.integrations ?? []) as WorkspaceIntegrationRow[]
        myUserId = (meRes as any)?.data?.id ?? null
      }

      // Per-user Composio view: surfaces in-flight states ("initiating", etc.)
      // for whoever is currently looking at the page.
      const personalRes = await bb.integrations.listConnections()
      const personal = (((personalRes as any)?.data ?? []) as Connection[]).filter((c) =>
        (SOCIAL as readonly string[]).includes(c.toolkit_slug),
      )
      const personalByToolkit = new Map(personal.map((c) => [c.toolkit_slug, c]))

      const merged: Connection[] = []
      const seen = new Set<string>()

      for (const row of workspaceRows) {
        seen.add(row.toolkit_slug)
        const personalMatch = personalByToolkit.get(row.toolkit_slug)
        merged.push({
          toolkit_slug: row.toolkit_slug,
          status: 'active',
          connected_at: row.connected_at,
          composio_account_id: row.composio_account_id,
          connected_by_user_id: row.connected_by_user_id,
          is_my_connection: myUserId ? row.connected_by_user_id === myUserId : !!personalMatch,
        })
      }

      for (const c of personal) {
        if (seen.has(c.toolkit_slug)) continue
        merged.push({ ...c, is_my_connection: true })
      }

      return merged
    },
    staleTime: 30_000,
  })
}
