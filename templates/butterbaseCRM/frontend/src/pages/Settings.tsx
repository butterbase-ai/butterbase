import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistanceToNowStrict } from 'date-fns';
import { useWorkspaces } from '@/hooks/useWorkspaces';
import { useSyncSettings, useUpdateSyncSettings } from '@/hooks/useSyncSettings';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { bb } from '@/lib/butterbase';
import type { Role } from '@/lib/types';
import {
  Mail,
  Check,
  Loader2,
  Plug,
  Copy,
  XCircle,
  LogOut,
  Lock,
  AtSign,
  Globe,
  Trash2,
  Plus,
  Sparkles,
  GitMerge,
  Bot,
  Building2,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { SocialConnectionsPanel } from '@/components/SocialConnectionsPanel';
import { useEditMode, type EditMode } from '@/lib/editMode';

interface PendingInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  invited_by: string;
  token: string;
  expires_at: string;
  created_at: string;
}

interface ConnectedAccount {
  id: string;
  toolkit_slug: string;
  status: 'active' | 'inactive' | 'expired';
  connected_at: string;
  last_used_at: string | null;
}

const ROLE_DOT: Record<Role, string> = {
  owner: 'bg-coral',
  admin: 'bg-butter',
  member: 'bg-muted-foreground',
};

function usePendingInvites(workspaceId: string) {
  return useQuery({
    queryKey: ['pending_invites', workspaceId],
    queryFn: async () => {
      const { data, error } = await bb
        .from<PendingInvite>('pending_invites')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

function useInviteMember(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ email, role }: { email: string; role: Role }) => {
      const { data, error } = await bb.functions.invoke('invite-member', {
        body: { workspace_id: workspaceId, email, role },
      });
      if (error) throw error;
      return data as {
        invite_id: string;
        token: string;
        invite_url: string;
        expires_at: string;
        email_sent: boolean;
        email_error: string | null;
        workspace_name: string;
      };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending_invites', workspaceId] }),
  });
}

function useRevokeInvite(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await bb.from('pending_invites').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending_invites', workspaceId] }),
  });
}

interface AllowlistEntry {
  id: string;
  entry_type: 'email' | 'domain';
  value: string;
  active: boolean;
  note: string | null;
  created_by: string;
  created_at: string;
}

function useAllowlist() {
  return useQuery({
    queryKey: ['app_allowlist'],
    queryFn: async (): Promise<AllowlistEntry[]> => {
      const { data, error } = await bb
        .from<AllowlistEntry>('app_allowlist')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

function useAddAllowlistEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { entry_type: 'email' | 'domain'; value: string; note?: string }) => {
      const { data: me } = await bb.auth.getUser();
      const userId = (me as any)?.id;
      if (!userId) throw new Error('Not signed in');
      const { error } = await bb.from('app_allowlist').insert({
        entry_type: input.entry_type,
        value: input.value.trim().toLowerCase(),
        active: true,
        note: input.note?.trim() || null,
        created_by: userId,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app_allowlist'] }),
  });
}

function useDeleteAllowlistEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await bb.from('app_allowlist').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['app_allowlist'] }),
  });
}

interface DuplicateCompanyPair {
  a_id: string; a_name: string; a_domain: string | null; a_description: string | null;
  b_id: string; b_name: string; b_domain: string | null; b_description: string | null;
  signal: 'same_domain' | 'same_name' | 'other';
  ai_verdict: 'merge' | 'skip' | 'unknown';
  ai_reason: string;
}
interface DuplicatePersonPair {
  a_id: string; a_first: string | null; a_last: string | null; a_email: string | null; a_title: string | null;
  b_id: string; b_first: string | null; b_last: string | null; b_email: string | null; b_title: string | null;
  signal: 'same_email' | 'same_name';
  ai_verdict: 'merge' | 'skip' | 'unknown';
  ai_reason: string;
}

function useFindDuplicates(workspaceId: string) {
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await bb.functions.invoke('find-duplicates', { body: { workspace_id: workspaceId } });
      if (error) throw error;
      return data as {
        counts: { companies_pairs_found: number; people_pairs_found: number; companies_evaluated: number; people_evaluated: number };
        companies: DuplicateCompanyPair[];
        people: DuplicatePersonPair[];
      };
    },
  });
}

function useConnectedIntegrations() {
  return useQuery({
    queryKey: ['connected_integrations'],
    queryFn: async (): Promise<ConnectedAccount[]> => {
      // SDK typing: bb.integrations.listConnections() => { data, error }
      const res = await bb.integrations.listConnections();
      if (res.error) throw res.error;
      return (res.data ?? []) as ConnectedAccount[];
    },
  });
}

/* ─────────────────────────────────────────────────────────── */

function EditModePreference() {
  const [mode, setMode] = useEditMode();
  const options: Array<{ value: EditMode; label: string; blurb: string }> = [
    {
      value: 'hover',
      label: 'Hover pencil (default)',
      blurb: 'Fields stay clickable and URLs open as real links. A small pencil appears on hover to enter edit mode.',
    },
    {
      value: 'toggle',
      label: 'Edit button',
      blurb: 'Fields are read-only by default. Click "Edit" at the top of a record to unlock all fields at once.',
    },
  ];
  return (
    <div className="card-flat p-5 space-y-3">
      {options.map((opt) => {
        const selected = mode === opt.value;
        return (
          <label
            key={opt.value}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
              selected ? 'border-foreground bg-accent/30' : 'border-border hover:border-foreground/40'
            }`}
          >
            <input
              type="radio"
              name="crm-edit-mode"
              value={opt.value}
              checked={selected}
              onChange={() => setMode(opt.value)}
              className="mt-1 accent-foreground"
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-medium text-foreground">{opt.label}</div>
              <div className="mt-0.5 font-editorial italic text-[12.5px] text-muted-foreground">{opt.blurb}</div>
            </div>
          </label>
        );
      })}
    </div>
  );
}

interface Competitor {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  keywords: string | null;
  created_at: string;
}

function useCompetitors(workspaceId: string) {
  return useQuery({
    queryKey: ['workspace_competitors', workspaceId],
    queryFn: async (): Promise<Competitor[]> => {
      const { data, error } = await bb
        .from<Competitor>('workspace_competitors')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

function useAddCompetitor(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; description?: string; keywords?: string }) => {
      const { error } = await bb.from('workspace_competitors').insert({
        workspace_id: workspaceId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        keywords: input.keywords?.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace_competitors', workspaceId] }),
  });
}

function useDeleteCompetitor(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await bb.from('workspace_competitors').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace_competitors', workspaceId] }),
  });
}

/* ─────────────────────────────────────────────────────────── */

function SectionShell({
  eyebrow,
  title,
  blurb,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-[180px_1fr] gap-6 md:gap-10 py-10 border-b border-border">
      <header>
        <p className="eyebrow mb-2">{eyebrow}</p>
        <h2 className="font-display text-[24px] leading-tight tracking-tight text-foreground">
          {title}
        </h2>
        {blurb && (
          <p className="mt-3 font-editorial italic text-[13.5px] text-muted-foreground leading-snug">
            {blurb}
          </p>
        )}
      </header>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

/* ─────────────────────────────────────────────────────────── */

export default function Settings() {
  const navigate = useNavigate();
  const ws = useCurrentWorkspaceId();
  const [params, setParams] = useSearchParams();

  const { data: workspaces = [], isLoading: wLoading } = useWorkspaces();
  const { data: invites = [] } = usePendingInvites(ws);
  const { data: connected = [], isLoading: cLoading, refetch: refetchConnected } =
    useConnectedIntegrations();

  const invite = useInviteMember(ws);
  const revoke = useRevokeInvite(ws);
  const { data: allowlist = [], isLoading: alLoading } = useAllowlist();
  const addAllowlist = useAddAllowlistEntry();
  const delAllowlist = useDeleteAllowlistEntry();
  const findDupes = useFindDuplicates(ws);
  const { data: competitors = [] } = useCompetitors(ws);
  const addCompetitor = useAddCompetitor(ws);
  const deleteCompetitor = useDeleteCompetitor(ws);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [googleConnecting, setGoogleConnecting] = useState(false);
  const [allowType, setAllowType] = useState<'email' | 'domain'>('email');
  const [allowValue, setAllowValue] = useState('');
  const [allowNote, setAllowNote] = useState('');
  const [newCompName, setNewCompName] = useState('');
  const [newCompDesc, setNewCompDesc] = useState('');
  const [newCompKeywords, setNewCompKeywords] = useState('');

  // Backed by sync_settings.notetaker_auto_enabled. On flip, the backend
  // (auto-sync-google + ingest-calendar + notetaker-sweeper cron) reads this
  // and dispatches Butterbase /ai/meetings bots to qualifying events.
  const { data: syncSettings } = useSyncSettings();
  const updateSyncSettings = useUpdateSyncSettings();
  const notetakerAuto = syncSettings?.notetaker_auto_enabled ?? true;
  const notetakerName = syncSettings?.notetaker_name ?? 'Notetaker';
  const [notetakerNameDraft, setNotetakerNameDraft] = useState<string>(notetakerName);
  useEffect(() => { setNotetakerNameDraft(notetakerName); }, [notetakerName]);

  const currentWorkspace = workspaces.find((w) => w.id === ws);
  const google = connected.find(
    (c) => c.toolkit_slug === 'googlesuper' && c.status === 'active',
  );
  const legacyGmail = connected.find((c) => c.toolkit_slug === 'gmail' && c.status === 'active');
  const legacyCalendar = connected.find((c) => c.toolkit_slug === 'google-calendar' && c.status === 'active');
  const needsLegacyReconnect = (!!legacyGmail || !!legacyCalendar) && !google;

  /* — pick up OAuth return signal — */
  useEffect(() => {
    const status = params.get('integration_status');
    const toolkit = params.get('integration');
    if (!status || !toolkit) return;

    if (status === 'success') {
      // Wait for the workspace to hydrate before binding — otherwise we'd skip
      // register-integration and strip the params, leaving no way to retry
      // without another OAuth round-trip.
      if (!ws) return;
      bb.functions
        .invoke('register-integration', { body: { workspace_id: ws, toolkit } })
        .catch((e) => {
          toast.error('Could not register integration with workspace', {
            description: e instanceof Error ? e.message : String(e),
          });
        });
      const label = toolkit === 'googlesuper' ? 'Google' : (toolkit[0].toUpperCase() + toolkit.slice(1));
      toast.success(`${label} connected`, {
        description: 'You can now send invites and outreach through this account.',
      });
    } else if (status === 'error') {
      toast.error(`${toolkit} connection failed`, {
        description: params.get('integration_error') ?? undefined,
      });
    }
    refetchConnected();
    params.delete('integration');
    params.delete('integration_status');
    params.delete('integration_error');
    setParams(params, { replace: true });
  }, [params, setParams, refetchConnected, ws]);

  async function handleConnectGoogle() {
    setGoogleConnecting(true);
    try {
      // Path-based redirect: the toolkit lives in the path segment so the
      // OAuth relay can append ?status=... without colliding with our own
      // query params (which would otherwise produce ...?integration=foo?status=bar).
      const redirectUrl = `${window.location.origin}/auth/callback/integration/googlesuper`;
      const { data, error } = await bb.integrations.connect('googlesuper', { redirectUrl });
      if (error) throw error;
      if (!data?.authUrl) throw new Error('No authorisation URL returned');
      window.location.href = data.authUrl;
    } catch (e) {
      setGoogleConnecting(false);
      toast.error(e instanceof Error ? e.message : 'Could not start Google connection');
    }
  }

  async function handleDisconnectGoogle() {
    if (!ws) return;
    try {
      // Sweep new + legacy slugs — best-effort cleanup for users mid-migration.
      const slugs = ['googlesuper', 'gmail', 'google-calendar'];
      for (const slug of slugs) {
        await bb.functions
          .invoke('unregister-integration', { body: { workspace_id: ws, toolkit: slug } })
          .catch(() => undefined);
      }
      toast.success('Google disconnected');
      refetchConnected();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Disconnect failed');
    }
  }

  async function handleSignOut() {
    try {
      await bb.auth.signOut();
      toast.success('Signed out');
      navigate('/login');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to sign out');
    }
  }

  async function handleInvite() {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      toast.error('Enter a valid email');
      return;
    }
    try {
      const result = await invite.mutateAsync({
        email: email.trim().toLowerCase(),
        role,
      });
      setEmail('');
      if (result.email_sent) {
        toast.success(`Invite emailed to ${result.workspace_name}'s new ${role}`);
      } else {
        await navigator.clipboard.writeText(result.invite_url).catch(() => undefined);
        toast.success('Invite link copied — share it with your teammate', {
          description: result.email_error
            ? `Gmail send failed (${result.email_error}). Link copied to clipboard.`
            : 'Connect Google to send invites automatically. Link copied to clipboard.',
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to invite');
    }
  }

  async function handleScanDuplicates() {
    try {
      const r = await findDupes.mutateAsync();
      toast.success(
        `Scan complete — ${r.companies.length} company pair${r.companies.length === 1 ? '' : 's'}, ${r.people.length} person pair${r.people.length === 1 ? '' : 's'} evaluated`,
        { description: `${r.counts.companies_pairs_found + r.counts.people_pairs_found} total candidates found.` },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Scan failed');
    }
  }

  async function handleAddAllowlist() {
    const v = allowValue.trim().toLowerCase();
    if (!v) {
      toast.error(allowType === 'email' ? 'Enter an email' : 'Enter a domain');
      return;
    }
    if (allowType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      toast.error('Enter a valid email');
      return;
    }
    if (allowType === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) {
      toast.error('Enter a valid domain (e.g. acme.com)');
      return;
    }
    try {
      await addAllowlist.mutateAsync({ entry_type: allowType, value: v, note: allowNote });
      setAllowValue('');
      setAllowNote('');
      toast.success(`Added ${allowType}: ${v}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add entry');
    }
  }

  async function copyInviteLink(token: string) {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Invite link copied');
    } catch {
      toast.error('Copy failed');
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="page-header">
        <div>
          <p className="eyebrow mb-3">Section 06 · Workshop</p>
          <h1 className="page-title">
            Settings <em>&amp; integrations</em>
          </h1>
          <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-md">
            Tune your workspace, invite collaborators, connect the tools that make outreach effortless.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-8">

          {/* Workspace */}
          <SectionShell
            eyebrow="Identity"
            title={<>Your <em className="font-editorial italic text-butter">workspace</em></>}
            blurb="The handle and home for your team’s shared ledger."
          >
            {wLoading ? (
              <Skeleton className="h-24" />
            ) : currentWorkspace ? (
              <div className="card-flat p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <p className="eyebrow mb-1.5">Name</p>
                    <p className="font-display text-[22px] tracking-tight text-foreground leading-none">
                      {currentWorkspace.name}
                    </p>
                  </div>
                  <div>
                    <p className="eyebrow mb-1.5">Slug</p>
                    <p className="font-mono text-[14px] text-foreground">
                      /{currentWorkspace.slug}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <p className="font-editorial italic text-muted-foreground">No workspace found.</p>
            )}
          </SectionShell>

          {/* Integrations */}
          <SectionShell
            eyebrow="Integrations"
            title={<>Connect <em className="font-editorial italic text-butter">the rails</em></>}
            blurb="Plug in your inbox so invites and follow-ups go out under your name."
          >
            <IntegrationCard
              icon={<GoogleMark />}
              name="Google"
              tagline="One connection for Gmail + Calendar — outreach, invites, and meeting sync."
              connected={!!google}
              loading={cLoading}
              connectedMeta={
                google
                  ? `connected ${formatDistanceToNowStrict(new Date(google.connected_at), { addSuffix: true })}`
                  : undefined
              }
              busy={googleConnecting}
              onConnect={handleConnectGoogle}
              onDisconnect={handleDisconnectGoogle}
            />

            {needsLegacyReconnect && (
              <div className="card-flat p-4 border border-coral/40 bg-coral/5">
                <p className="text-[13px] text-foreground">
                  <span className="font-mono text-coral">Action needed:</span>{' '}
                  Your Gmail / Calendar connections use an older format. Click
                  <span className="font-mono"> Connect Google </span>
                  above once to consolidate — your existing data stays intact.
                </p>
              </div>
            )}

            <p className="font-editorial italic text-[12.5px] text-muted-foreground/80 pl-1">
              Gmail and Calendar sync automatically every few minutes once Google is connected.
            </p>

            <div className="pt-4 border-t border-gray-200">
              <SocialConnectionsPanel workspace_id={ws ?? null} />
            </div>
          </SectionShell>

          {/* Invite */}
          <SectionShell
            eyebrow="Collaboration"
            title={<>Invite a <em className="font-editorial italic text-butter">teammate</em></>}
            blurb={
              google
                ? 'A magic link will be emailed from your Gmail. Expires in 7 days.'
                : 'Without Google connected, the link is copied to your clipboard.'
            }
          >
            <div className="card-flat p-5 space-y-4">
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  type="email"
                  placeholder="teammate@acme.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="flex-1 h-10 bg-background"
                />
                <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                  <SelectTrigger className="w-full sm:w-32 h-10 bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  onClick={handleInvite}
                  disabled={invite.isPending || !email.trim()}
                  className="h-10 px-5 bg-foreground text-background hover:bg-foreground/85"
                >
                  {invite.isPending ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      Sending
                    </>
                  ) : (
                    'Send invite'
                  )}
                </Button>
              </div>

              {!google && (
                <div className="flex items-start gap-2 rounded-md border border-butter/50 bg-butter/10 px-3 py-2">
                  <Mail className="h-3.5 w-3.5 mt-0.5 text-foreground/80 shrink-0" />
                  <p className="text-[12.5px] text-foreground/80 leading-snug">
                    Connect Google above to automatically email invites instead of copying links.
                  </p>
                </div>
              )}
            </div>

            {invites.length > 0 && (
              <div className="card-flat overflow-hidden">
                <div className="px-5 pt-4 pb-3 flex items-center justify-between">
                  <p className="eyebrow">Pending · {invites.length}</p>
                </div>
                <div className="divide-y divide-border">
                  {invites.map((i) => (
                    <div key={i.id} className="px-5 py-3 flex items-center gap-4">
                      <span className={`h-1.5 w-1.5 rounded-full ${ROLE_DOT[i.role]}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13.5px] text-foreground truncate">{i.email}</p>
                        <p className="font-editorial italic text-[12px] text-muted-foreground">
                          {i.role} · expires {formatDistanceToNowStrict(new Date(i.expires_at), { addSuffix: true })}
                        </p>
                      </div>
                      <button
                        onClick={() => copyInviteLink(i.token)}
                        className="text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded hover:bg-foreground/5"
                        title="Copy invite link"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() =>
                          revoke.mutate(i.id, {
                            onSuccess: () => toast.success('Invite revoked'),
                            onError: (e) =>
                              toast.error(e instanceof Error ? e.message : 'Failed to revoke'),
                          })
                        }
                        className="text-muted-foreground hover:text-coral transition-colors p-1.5 rounded hover:bg-coral/10"
                        title="Revoke"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionShell>

          {/* Duplicates (AI merge suggestions) */}
          <SectionShell
            eyebrow="Duplicates"
            title={<>Find <em className="font-editorial italic text-butter">duplicates</em></>}
            blurb="Scans companies and people for likely duplicates (same domain, same name, same email). The AI gives a merge/skip verdict on the strongest pairs."
          >
            <div className="card-flat p-5 flex items-center gap-4">
              <div className="grid place-items-center h-11 w-11 rounded-md bg-background border border-border shrink-0">
                <GitMerge className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-[18px] tracking-tight text-foreground leading-none">
                  Duplicate scan
                </h3>
                <p className="mt-1 font-editorial italic text-[13px] text-muted-foreground">
                  Read-only — surfaces suggestions only. Actually merging records is a manual step for now.
                </p>
              </div>
              <Button
                onClick={handleScanDuplicates}
                disabled={findDupes.isPending}
                className="gap-2 bg-foreground text-background hover:bg-foreground/85"
              >
                {findDupes.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Scan
              </Button>
            </div>

            {findDupes.data && (
              <div className="space-y-4">
                {findDupes.data.companies.length === 0 && findDupes.data.people.length === 0 ? (
                  <p className="font-editorial italic text-[13px] text-muted-foreground">
                    No duplicate candidates found. Nice.
                  </p>
                ) : (
                  <>
                    {findDupes.data.companies.length > 0 && (
                      <div>
                        <p className="eyebrow mb-2">Companies</p>
                        <ul className="space-y-1.5">
                          {findDupes.data.companies.map((p) => (
                            <li key={`${p.a_id}-${p.b_id}`} className="card-flat p-4 space-y-2">
                              <div className="flex items-center gap-2">
                                <span className={`stage-pill ${p.ai_verdict === 'merge' ? '!bg-coral/15 !text-coral' : p.ai_verdict === 'skip' ? '!bg-sage/15 !text-sage' : ''}`}>
                                  {p.ai_verdict}
                                </span>
                                <span className="font-mono text-[10.5px] text-muted-foreground">{p.signal}</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
                                <div>
                                  <p className="text-foreground">{p.a_name}</p>
                                  <p className="font-mono text-[11px] text-muted-foreground">{p.a_domain ?? '—'}</p>
                                </div>
                                <div>
                                  <p className="text-foreground">{p.b_name}</p>
                                  <p className="font-mono text-[11px] text-muted-foreground">{p.b_domain ?? '—'}</p>
                                </div>
                              </div>
                              {p.ai_reason && (
                                <p className="font-editorial italic text-[12.5px] text-muted-foreground border-t border-border pt-2">{p.ai_reason}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {findDupes.data.people.length > 0 && (
                      <div>
                        <p className="eyebrow mb-2">People</p>
                        <ul className="space-y-1.5">
                          {findDupes.data.people.map((p) => (
                            <li key={`${p.a_id}-${p.b_id}`} className="card-flat p-4 space-y-2">
                              <div className="flex items-center gap-2">
                                <span className={`stage-pill ${p.ai_verdict === 'merge' ? '!bg-coral/15 !text-coral' : p.ai_verdict === 'skip' ? '!bg-sage/15 !text-sage' : ''}`}>
                                  {p.ai_verdict}
                                </span>
                                <span className="font-mono text-[10.5px] text-muted-foreground">{p.signal}</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
                                <div>
                                  <p className="text-foreground">{[p.a_first, p.a_last].filter(Boolean).join(' ') || '—'}</p>
                                  <p className="font-mono text-[11px] text-muted-foreground">{p.a_email ?? '—'}</p>
                                </div>
                                <div>
                                  <p className="text-foreground">{[p.b_first, p.b_last].filter(Boolean).join(' ') || '—'}</p>
                                  <p className="font-mono text-[11px] text-muted-foreground">{p.b_email ?? '—'}</p>
                                </div>
                              </div>
                              {p.ai_reason && (
                                <p className="font-editorial italic text-[12.5px] text-muted-foreground border-t border-border pt-2">{p.ai_reason}</p>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </SectionShell>

          {/* Access (app-wide allowlist) */}
          <SectionShell
            eyebrow="Access"
            title={<>Who can <em className="font-editorial italic text-butter">sign in</em></>}
            blurb="App-wide allowlist enforced at login. Empty list = the next signup auto-seeds the list and becomes the implicit owner."
          >
            <div className="card-flat p-5 space-y-4">
              <div className="flex flex-col sm:flex-row gap-2">
                <Select value={allowType} onValueChange={(v) => setAllowType(v as 'email' | 'domain')}>
                  <SelectTrigger className="w-full sm:w-32 h-10 bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="domain">Domain</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="text"
                  placeholder={allowType === 'email' ? 'alice@acme.com' : 'acme.com'}
                  value={allowValue}
                  onChange={(e) => setAllowValue(e.target.value)}
                  className="flex-1 h-10 bg-background"
                />
                <Input
                  type="text"
                  placeholder="Note (optional)"
                  value={allowNote}
                  onChange={(e) => setAllowNote(e.target.value)}
                  className="flex-1 h-10 bg-background"
                />
                <Button
                  onClick={handleAddAllowlist}
                  disabled={addAllowlist.isPending || !allowValue.trim()}
                  className="h-10 px-5 bg-foreground text-background hover:bg-foreground/85 gap-2"
                >
                  {addAllowlist.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  Add
                </Button>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-butter/40 bg-butter/5 px-3 py-2">
                <Lock className="h-3.5 w-3.5 mt-0.5 text-foreground/70 shrink-0" />
                <p className="text-[12.5px] text-foreground/75 leading-snug">
                  Visible only to workspace owners/admins. Login checks run server-side via the <span className="font-mono">check-allowlist</span> function — if denied, the user is signed out immediately.
                </p>
              </div>
            </div>

            {alLoading ? (
              <Skeleton className="h-24" />
            ) : allowlist.length === 0 ? (
              <p className="font-editorial italic text-muted-foreground">
                No entries yet — the next user to sign in will be added automatically.
              </p>
            ) : (
              <div className="card-flat overflow-hidden">
                <div className="px-5 pt-4 pb-3 flex items-center justify-between">
                  <p className="eyebrow">Entries · {allowlist.length}</p>
                </div>
                <div className="divide-y divide-border">
                  {allowlist.map((a) => (
                    <div key={a.id} className="px-5 py-3 flex items-center gap-4">
                      <div className="grid place-items-center h-7 w-7 rounded-md bg-background border border-border shrink-0">
                        {a.entry_type === 'email' ? (
                          <AtSign className="h-3.5 w-3.5" />
                        ) : (
                          <Globe className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-[13px] text-foreground truncate">{a.value}</p>
                        <p className="font-editorial italic text-[12px] text-muted-foreground">
                          {a.entry_type}
                          {a.note ? ` · ${a.note}` : ''}
                          {' · added '}
                          {formatDistanceToNowStrict(new Date(a.created_at), { addSuffix: true })}
                          {!a.active && ' · inactive'}
                        </p>
                      </div>
                      <button
                        onClick={() =>
                          delAllowlist.mutate(a.id, {
                            onSuccess: () => toast.success('Entry removed'),
                            onError: (e) =>
                              toast.error(e instanceof Error ? e.message : 'Failed to remove'),
                          })
                        }
                        className="text-muted-foreground hover:text-coral transition-colors p-1.5 rounded hover:bg-coral/10"
                        title="Remove"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </SectionShell>

          {/* Meeting notetaker */}
          <SectionShell
            eyebrow="Meetings"
            title={<>Meeting <em className="font-editorial italic text-butter">notetaker</em></>}
            blurb="A bot that joins Zoom / Meet / Teams / Webex calls, transcribes, and posts decisions, commitments, and learnings back to each meeting. On by default."
          >
            <div className="card-flat p-5 flex items-center gap-4">
              <div className="grid place-items-center h-11 w-11 rounded-md bg-background border border-border shrink-0">
                <Bot className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-display text-[18px] tracking-tight text-foreground leading-none">
                    Enable notetaker
                  </h3>
                </div>
                <p className="mt-1 font-editorial italic text-[13px] text-muted-foreground">
                  When on, every upcoming calendar event with a Zoom/Meet/Teams/Webex link gets a notetaker bot. Billed against your Butterbase AI credits.
                </p>
              </div>
              <Switch
                checked={notetakerAuto}
                onCheckedChange={(checked) => {
                  updateSyncSettings.mutate(
                    { notetaker_auto_enabled: checked },
                    {
                      onSuccess: () => toast.success(checked ? 'Notetaker on' : 'Notetaker off'),
                      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
                    },
                  );
                }}
                disabled={updateSyncSettings.isPending || !syncSettings}
                aria-label="Enable notetaker"
              />
            </div>
            <div className="card-flat p-5 flex items-center gap-4">
              <div className="grid place-items-center h-11 w-11 rounded-md bg-background border border-border shrink-0">
                <Bot className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-[16px] tracking-tight text-foreground leading-none">
                  Display name in calls
                </h3>
                <p className="mt-1 font-editorial italic text-[13px] text-muted-foreground">
                  What other meeting attendees see as the bot's name. Keep it recognizable — e.g. "{currentWorkspace?.name ?? 'Acme'} Notetaker".
                </p>
              </div>
              <Input
                type="text"
                maxLength={64}
                className="w-56 h-9 text-[13px]"
                value={notetakerNameDraft}
                onChange={(e) => setNotetakerNameDraft(e.target.value)}
                onBlur={() => {
                  const next = notetakerNameDraft.trim();
                  if (!next) {
                    setNotetakerNameDraft(notetakerName);
                    return;
                  }
                  if (next === notetakerName) return;
                  updateSyncSettings.mutate(
                    { notetaker_name: next },
                    {
                      onSuccess: () => toast.success('Notetaker name updated'),
                      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not save'),
                    },
                  );
                }}
                placeholder="Notetaker"
                disabled={updateSyncSettings.isPending || !syncSettings}
                aria-label="Notetaker display name"
              />
            </div>
            <p className="font-editorial italic text-[12.5px] text-muted-foreground/80 pl-1 leading-snug">
              You can also manually send a bot from any meeting dialog.
            </p>
          </SectionShell>

          {/* Appearance */}
          <SectionShell
            eyebrow="Appearance"
            title={<>Detail-page <em className="font-editorial italic text-butter">editing</em></>}
            blurb="Choose how record detail pages behave when you click a field."
          >
            <EditModePreference />
          </SectionShell>

          {/* Account */}
          <SectionShell
            eyebrow="Account"
            title={<>Sign <em className="font-editorial italic text-butter">off</em></>}
            blurb="End your session on this device."
          >
            <div className="card-flat p-5 flex items-center justify-between">
              <div>
                <p className="text-[14px] text-foreground">Sign out of Butterbase CRM</p>
                <p className="font-editorial italic text-[12.5px] text-muted-foreground">
                  You can sign back in any time.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleSignOut}
                className="gap-2 border-coral/40 text-coral hover:bg-coral/10 hover:text-coral"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </Button>
            </div>
          </SectionShell>

          {/* Competitors */}
          <SectionShell
            eyebrow="Competitors"
            title={<>Track <em className="font-editorial italic text-butter">competitors</em></>}
            blurb="Add competitors you want to monitor. The auto-discovery cron searches Reddit and LinkedIn for posts mentioning them and queues comment drafts for your review every 6 hours."
          >
            {competitors.length > 0 && (
              <div className="space-y-2">
                {competitors.map((c) => (
                  <div key={c.id} className="card-flat p-4 flex items-start gap-3">
                    <div className="grid place-items-center h-9 w-9 rounded-md bg-background border border-border shrink-0 mt-0.5">
                      <Building2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-foreground leading-none">{c.name}</p>
                      {c.description && (
                        <p className="mt-0.5 font-editorial italic text-[12.5px] text-muted-foreground">{c.description}</p>
                      )}
                      {c.keywords && (
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/70">{c.keywords}</p>
                      )}
                    </div>
                    <button
                      onClick={() =>
                        deleteCompetitor.mutate(c.id, {
                          onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
                        })
                      }
                      className="text-muted-foreground hover:text-coral transition-colors p-1.5 rounded hover:bg-coral/10 shrink-0"
                      title="Remove competitor"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="card-flat p-5 space-y-3">
              <p className="eyebrow">Add competitor</p>
              <div className="space-y-2">
                <Input
                  value={newCompName}
                  onChange={(e) => setNewCompName(e.target.value)}
                  placeholder="Competitor name (e.g. Salesforce)"
                />
                <Input
                  value={newCompDesc}
                  onChange={(e) => setNewCompDesc(e.target.value)}
                  placeholder="Description — what do they sell? (optional)"
                />
                <Input
                  value={newCompKeywords}
                  onChange={(e) => setNewCompKeywords(e.target.value)}
                  placeholder="Extra keywords for search (optional, e.g. CRM enterprise)"
                />
              </div>
              <Button
                size="sm"
                disabled={!newCompName.trim() || addCompetitor.isPending}
                onClick={() =>
                  addCompetitor.mutate(
                    { name: newCompName, description: newCompDesc, keywords: newCompKeywords },
                    {
                      onSuccess: () => {
                        toast.success('Competitor added');
                        setNewCompName('');
                        setNewCompDesc('');
                        setNewCompKeywords('');
                      },
                      onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed to add'),
                    },
                  )
                }
                className="gap-2 bg-foreground text-background hover:bg-foreground/85"
              >
                {addCompetitor.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Add competitor
              </Button>
            </div>
          </SectionShell>

          <div className="py-12 text-center">
            <p className="font-editorial italic text-[13px] text-muted-foreground">
              — end of settings —
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────── */

function IntegrationCard({
  icon,
  name,
  tagline,
  connected,
  connectedMeta,
  loading,
  busy,
  onConnect,
  onDisconnect,
}: {
  icon: React.ReactNode;
  name: string;
  tagline: string;
  connected: boolean;
  connectedMeta?: string;
  loading: boolean;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <div className="card-flat p-5 flex items-center gap-4">
      <div className="grid place-items-center h-11 w-11 rounded-md bg-background border border-border shrink-0">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="font-display text-[18px] tracking-tight text-foreground leading-none">
            {name}
          </h3>
          {loading ? (
            <span className="font-editorial italic text-[12px] text-muted-foreground">
              checking…
            </span>
          ) : connected ? (
            <span className="stage-pill !bg-sage/15 !text-sage">
              <Check className="h-2.5 w-2.5" strokeWidth={3} />
              connected
            </span>
          ) : (
            <span className="stage-pill">not connected</span>
          )}
        </div>
        <p className="mt-1 font-editorial italic text-[13px] text-muted-foreground">
          {connectedMeta ?? tagline}
        </p>
      </div>
      {connected ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDisconnect}
          className="text-muted-foreground hover:text-coral"
        >
          Disconnect
        </Button>
      ) : (
        <Button
          onClick={onConnect}
          disabled={busy}
          className="gap-2 bg-foreground text-background hover:bg-foreground/85"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plug className="h-3.5 w-3.5" />
          )}
          Connect {name}
        </Button>
      )}
    </div>
  );
}


function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/>
      <path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"/>
    </svg>
  );
}
