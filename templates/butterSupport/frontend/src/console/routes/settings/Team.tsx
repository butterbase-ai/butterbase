import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { api } from '@/console/lib/api';
import { Button } from '@/console/components/ui/button';
import { Input } from '@/console/components/ui/input';
import { Select } from '@/console/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { Badge } from '@/console/components/ui/badge';
import { SettingsPage } from '@/console/components/SettingsPage';
import { toast } from '@/console/components/ui/toast';
import { confirm } from '@/console/components/ui/confirm';

export function TeamSettings() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: members = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: async () => {
      const res: any = await bb.from('memberships').select('*');
      return Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    },
  });

  async function invite() {
    setBusy(true); setErr(null);
    try {
      await api.inviteTeammate({ email, default_role: role, send_email: true });
      setEmail('');
      qc.invalidateQueries({ queryKey: ['memberships'] });
    } catch (e: any) {
      setErr(e?.message || 'Invite failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(userId: string) {
    if (!(await confirm({ title: 'Remove teammate?', description: 'They will lose access to the support console immediately.', confirmLabel: 'Remove', variant: 'destructive' }))) return;
    try {
      await api.removeTeammate({ user_id: userId, remove_from_allowlist: true });
      qc.invalidateQueries({ queryKey: ['memberships'] });
      toast.success('Teammate removed');
    } catch (e: any) {
      toast.error(e?.message || 'Remove failed');
    }
  }

  return (
    <SettingsPage
      label="Team"
      title={<>Your support <em>team</em></>}
      description="Invite teammates, set roles, and manage who can drive the support console."
    >
      <Card>
        <CardHeader><CardTitle>Invite a teammate</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 min-w-[240px]" />
            <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-40">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </Select>
            <Button onClick={invite} disabled={!email || busy}>{busy ? 'Inviting…' : 'Send invite'}</Button>
          </div>
          {err && <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2 text-xs text-destructive">{err}</div>}
        </CardContent>
      </Card>

      <div>
        <div className="section-label mb-3">Members · {members.length}</div>
        <div className="rounded-2xl border border-rule-soft bg-paper-soft divide-y divide-[rgb(244_236_221/0.06)]">
          {members.map((m: any) => (
            <div key={m.user_id} className="flex items-center gap-3 px-4 py-3">
              <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-butter-200 to-caramel-deep font-mono text-[11px] font-bold text-[#1A1208]">
                {(m.invited_email || m.user_email || m.user_id)?.[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0 text-sm">
                <div className="font-medium text-foreground truncate">{m.invited_email || m.user_email || m.user_id}</div>
                <div className="font-mono text-[10px] text-muted-foreground truncate">{m.user_id}</div>
              </div>
              <Badge variant="outline">{m.role}</Badge>
              <Button size="sm" variant="ghost" onClick={() => remove(m.user_id)}>Remove</Button>
            </div>
          ))}
          {members.length === 0 && <div className="p-4 text-sm text-muted-foreground">No team members yet.</div>}
        </div>
      </div>
    </SettingsPage>
  );
}
