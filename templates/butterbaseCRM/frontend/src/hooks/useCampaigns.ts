import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb, bbInvoke } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import type { Campaign, CampaignList, CampaignListMember, CampaignSend } from '@/lib/types';

// Lists + campaigns are SQL-resident. People/companies live in substrate and
// are referenced from members/sends by text id (ent_…). Per-recipient template
// vars and email are snapshotted onto campaign_list_members at list creation
// time so the campaign runner never hits substrate.

export function useCampaignLists() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.campaignLists(ws),
    queryFn: async () => {
      const { data, error } = await bb.from<CampaignList>('campaign_lists')
        .select('*')
        .eq('workspace_id', ws)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CampaignList[];
    },
    enabled: !!ws,
  });
}

export function useCampaignList(listId: string | null) {
  return useQuery({
    queryKey: qk.campaignList(listId ?? ''),
    queryFn: async () => {
      if (!listId) return null;
      const { data, error } = await bb.from<CampaignList>('campaign_lists')
        .select('*')
        .eq('id', listId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as CampaignList | null;
    },
    enabled: !!listId,
  });
}

export function useCampaignListMembers(listId: string | null) {
  return useQuery({
    queryKey: ['campaignListMembers', listId],
    queryFn: async () => {
      const { data, error } = await bb.from<CampaignListMember>('campaign_list_members')
        .select('*')
        .eq('list_id', listId!)
        .order('added_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CampaignListMember[];
    },
    enabled: !!listId,
  });
}

export interface CreateListMemberInput {
  id: string; // substrate entity id (ent_…)
  email?: string | null;
  vars?: { first_name?: string | null; last_name?: string | null; title?: string | null; company_name?: string | null };
}

export interface CreateListInput {
  name: string;
  description?: string;
  entity_type: 'people' | 'companies';
  source: 'manual' | 'ai_search';
  source_spec?: Record<string, unknown>;
  members: CreateListMemberInput[];
}

export function useCreateCampaignList() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateListInput) => {
      const { data, error } = await bbInvoke<{ list: CampaignList; member_count: number }>(
        'create-campaign-list',
        { ...input, workspace_id: ws },
      );
      if (error) throw error;
      if (!data) throw new Error('create-campaign-list returned no data');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.campaignLists(ws) });
    },
  });
}

export function useDeleteCampaignList() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await bb.from('campaign_lists').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.campaignLists(ws) });
    },
  });
}

// ─── Campaigns ────────────────────────────────────────────────────────────

export function useCampaigns() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.campaigns(ws),
    queryFn: async () => {
      const { data, error } = await bb.from<Campaign>('campaigns')
        .select('*')
        .eq('workspace_id', ws)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Campaign[];
    },
    enabled: !!ws,
  });
}

export function useCampaign(id: string | null) {
  return useQuery({
    queryKey: qk.campaign(id ?? ''),
    queryFn: async () => {
      if (!id) return null;
      const { data, error } = await bb.from<Campaign>('campaigns')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as Campaign | null;
    },
    enabled: !!id,
  });
}

export interface CreateCampaignInput {
  name: string;
  list_id: string;
  subject: string;
  body_template: string;
  from_user_id: string;
  daily_limit?: number;
  throttle_seconds?: number;
}

export function useCreateCampaign() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCampaignInput) => {
      const clamped = {
        ...input,
        daily_limit: Math.max(1, Math.min(30, input.daily_limit ?? 25)),
        throttle_seconds: Math.max(60, Math.min(3600, input.throttle_seconds ?? 180)),
      };
      const userRes: any = await bb.auth.getUser();
      const userId = userRes?.data?.user?.id ?? userRes?.data?.id ?? null;
      if (!userId) throw new Error('Not authenticated');
      const { data, error } = await bb.from<Campaign>('campaigns')
        .insert({ ...clamped, workspace_id: ws, created_by: userId } as any)
        .select('*');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error('campaigns insert returned no row');
      return row as Campaign;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.campaigns(ws) }),
  });
}

export function useStartCampaign() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (campaign_id: string) => {
      const { data, error } = await bbInvoke('start-campaign', { campaign_id });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, campaign_id) => {
      qc.invalidateQueries({ queryKey: qk.campaigns(ws) });
      qc.invalidateQueries({ queryKey: qk.campaign(campaign_id) });
      qc.invalidateQueries({ queryKey: qk.campaignSends(campaign_id) });
    },
  });
}

export function useCampaignControl() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { campaign_id: string; action: 'pause' | 'resume' | 'cancel' }) => {
      const { data, error } = await bbInvoke('pause-campaign', input);
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, input) => {
      qc.invalidateQueries({ queryKey: qk.campaigns(ws) });
      qc.invalidateQueries({ queryKey: qk.campaign(input.campaign_id) });
    },
  });
}

export function useCampaignSends(campaignId: string | null) {
  return useQuery({
    queryKey: qk.campaignSends(campaignId ?? ''),
    queryFn: async () => {
      const { data, error } = await bb.from<CampaignSend>('campaign_sends')
        .select('*')
        .eq('campaign_id', campaignId!)
        .order('scheduled_for', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CampaignSend[];
    },
    enabled: !!campaignId,
  });
}
