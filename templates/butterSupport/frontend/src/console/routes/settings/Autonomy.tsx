import { uiMessage, uiText, useUiLocale } from "../../../i18n";
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb, APP_ID } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Input } from '@/console/components/ui/input';
import { Select } from '@/console/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { Badge } from '@/console/components/ui/badge';
import { SettingsPage } from '@/console/components/SettingsPage';
import { toast } from '@/console/components/ui/toast';
import { confirm } from '@/console/components/ui/confirm';

type Mode = 'draft_for_approval' | 'auto_send' | 'auto_resolve' | 'force_escalate';
type Row = { issue_type: string; mode: Mode; updated_at: string };

const MODES: Mode[] = ['draft_for_approval', 'auto_send', 'auto_resolve', 'force_escalate'];

const MODE_COPY: Record<Mode, { label: string; desc: string; tone: 'safe' | 'caution' | 'danger' }> = {
  draft_for_approval: {
    get label() { return uiText('Draft for approval'); },
    get desc() { return uiText('Agent drafts; a founder must approve before the customer sees anything.'); },
    tone: 'safe',
  },
  auto_send: {
    get label() { return uiText('Auto-send'); },
    get desc() { return uiText('Agent sends replies directly. Escalations still require approval.'); },
    tone: 'caution',
  },
  auto_resolve: {
    get label() { return uiText('Auto-resolve'); },
    get desc() { return uiText('Agent replies and closes tickets when it judges the issue resolved. Highest autonomy.'); },
    tone: 'danger',
  },
  force_escalate: {
    get label() { return uiText('Always escalate'); },
    get desc() { return uiText('Agent never drafts a reply. Every ticket of this type goes straight to a human via your default escalation target.'); },
    tone: 'caution',
  },
};

export function AutonomySettings() {
  useUiLocale();
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: ['autonomy_settings'],
    queryFn: async () => {
      const res: any = await bb.from('autonomy_settings').select('*').order('issue_type', { ascending: true });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as Row[];
    },
  });

  const defaultRow = rows.find((r) => r.issue_type === 'default');
  const overrides = rows.filter((r) => r.issue_type !== 'default');

  const [newType, setNewType] = useState('');
  const [newMode, setNewMode] = useState<Mode>('draft_for_approval');
  const [busy, setBusy] = useState(false);

  async function updateMode(issue_type: string, mode: Mode) {
    if (mode !== 'draft_for_approval') {
      const ok = await confirm({
        title: uiMessage`Switch "${issue_type}" to ${MODE_COPY[mode].label}?`,
        description: MODE_COPY[mode].desc,
        confirmLabel: uiText('Switch'),
        variant: MODE_COPY[mode].tone === 'danger' ? 'destructive' : 'default',
      });
      if (!ok) return;
    }
    try {
      await (bb as any).request(
        'POST',
        `/v1/${APP_ID}/fn/admin-autonomy`,
        { action: 'upsert', issue_type, mode },
      );
      qc.invalidateQueries({ queryKey: ['autonomy_settings'] });
      toast.success(uiMessage`"${issue_type}" set to ${MODE_COPY[mode].label}`);
    } catch (e: any) {
      toast.error(e?.message || uiText('Update failed'));
    }
  }

  async function addOverride() {
    const issue_type = newType.trim().toLowerCase().replace(/\s+/g, '_');
    if (!issue_type) return;
    if (issue_type === 'default') {
      toast.warning(uiText('"default" already exists. Edit the row above instead.'));
      return;
    }
    if (rows.some((r) => r.issue_type === issue_type)) {
      toast.warning(uiMessage`Override for "${issue_type}" already exists.`);
      return;
    }
    setBusy(true);
    try {
      await (bb as any).request(
        'POST',
        `/v1/${APP_ID}/fn/admin-autonomy`,
        { action: 'upsert', issue_type, mode: newMode },
      );
      setNewType('');
      setNewMode('draft_for_approval');
      qc.invalidateQueries({ queryKey: ['autonomy_settings'] });
      toast.success(uiMessage`Override added for "${issue_type}"`);
    } catch (e: any) {
      toast.error(e?.message || uiText('Add failed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(issue_type: string) {
    const ok = await confirm({
      title: uiMessage`Remove "${issue_type}" override?`,
      description: uiText('It will fall back to the default mode.'),
      confirmLabel: uiText('Remove'),
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await (bb as any).request(
        'POST',
        `/v1/${APP_ID}/fn/admin-autonomy`,
        { action: 'delete', issue_type },
      );
      qc.invalidateQueries({ queryKey: ['autonomy_settings'] });
      toast.success(uiMessage`"${issue_type}" override removed`);
    } catch (e: any) {
      toast.error(e?.message || uiText('Remove failed'));
    }
  }

  const RECOMMENDED_DEFAULTS: Array<{ issue_type: string; mode: Mode }> = [
    { issue_type: 'billing', mode: 'force_escalate' },
    { issue_type: 'cancellation', mode: 'force_escalate' },
    { issue_type: 'refund_request', mode: 'force_escalate' },
    { issue_type: 'account_deletion', mode: 'force_escalate' },
    { issue_type: 'data_privacy', mode: 'force_escalate' },
    { issue_type: 'security_incident', mode: 'force_escalate' },
    { issue_type: 'legal', mode: 'force_escalate' },
    { issue_type: 'complaint', mode: 'force_escalate' },
    { issue_type: 'outage', mode: 'force_escalate' },
    { issue_type: 'password_reset', mode: 'auto_resolve' },
    { issue_type: 'how_to', mode: 'auto_resolve' },
    { issue_type: 'pricing_inquiry', mode: 'auto_resolve' },
  ];

  async function applyRecommendedDefaults() {
    const ok = await confirm({
      title: uiText('Insert recommended overrides?'),
      description: uiMessage`${RECOMMENDED_DEFAULTS.length} recommended autonomy overrides will be inserted. Existing rows with the same issue_type will be left alone.`,
      confirmLabel: uiText('Insert'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const existing = new Set(rows.map((r) => r.issue_type));
      let inserted = 0;
      for (const def of RECOMMENDED_DEFAULTS) {
        if (existing.has(def.issue_type)) continue;
        await (bb as any).request(
          'POST',
          `/v1/${APP_ID}/fn/admin-autonomy`,
          { action: 'upsert', issue_type: def.issue_type, mode: def.mode },
        );
        inserted++;
      }
      qc.invalidateQueries({ queryKey: ['autonomy_settings'] });
      toast.success(uiMessage`Inserted ${inserted} of ${RECOMMENDED_DEFAULTS.length} recommended overrides`, {
        title: RECOMMENDED_DEFAULTS.length - inserted > 0 ? `${RECOMMENDED_DEFAULTS.length - inserted} already existed` : undefined,
      });
    } catch (e: any) {
      toast.error(e?.message || uiText('Apply failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage
      label={uiText("Section 10 · Autonomy")}
      title={<>{uiText("How ")}<em>{uiText("free")}</em> {uiText(" is the agent?")}</>}
      description={uiText("Set a default autonomy mode for all tickets, and override per issue type.")}
    >
      <Card>
        <CardHeader><CardTitle>{uiText("Default mode")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {uiText("Applied to every ticket unless an override below matches the ticket's ")}<code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">issue_type</code>.
          </p>
          {defaultRow ? (
            <ModeRow row={defaultRow} onChange={(m) => updateMode('default', m)} canRemove={false} />
          ) : (
            <p className="text-sm text-caramel">{uiText("No default row found. Re-seed via ")}<code>autonomy_settings</code>.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{uiText("Per-issue overrides")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {rows.length <= 1 && (
            <div className="rounded-2xl border border-dashed border-rule-soft bg-paper-soft/40 p-4">
              <div className="mb-2 text-sm font-medium text-foreground">{uiText("Get started in one click")}</div>
              <p className="mb-3 text-xs text-muted-foreground">
                {uiText("Seed 12 common overrides: billing / cancellation / refund / legal / security & 6 more force-escalate; password_reset / how_to / pricing_inquiry auto-resolve.")}</p>
              <Button size="sm" variant="outline" onClick={applyRecommendedDefaults} disabled={busy}>
                {busy ? uiText('Applying…') : uiText('Apply recommended defaults')}
              </Button>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {uiText("Override autonomy for specific issue types produced by the classifier (e.g. ")}<code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">billing</code>, <code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">password_reset</code>).
          </p>

          <div className="flex gap-2 flex-wrap">
            <Input
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              placeholder={uiText("issue_type · e.g. billing")}
              className="flex-1 min-w-[200px]"
            />
            <Select value={newMode} onChange={(e) => setNewMode(e.target.value as Mode)} className="w-52">
              {MODES.map((m) => <option key={m} value={m}>{MODE_COPY[m].label}</option>)}
            </Select>
            <Button onClick={addOverride} disabled={!newType.trim() || busy}>{uiText("Add override")}</Button>
          </div>

          <div className="rounded-2xl border border-rule-soft bg-paper-soft divide-y divide-[rgb(244_236_221/0.06)]">
            {overrides.map((r) => (
              <div key={r.issue_type} className="p-4">
                <ModeRow row={r} onChange={(m) => updateMode(r.issue_type, m)} canRemove onRemove={() => remove(r.issue_type)} />
              </div>
            ))}
            {overrides.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground">{uiText("No overrides yet — all tickets use the default mode.")}</div>
            )}
          </div>
        </CardContent>
      </Card>
    </SettingsPage>
  );
}

function ModeRow({
  row,
  onChange,
  canRemove,
  onRemove,
}: {
  row: Row;
  onChange: (m: Mode) => void;
  canRemove: boolean;
  onRemove?: () => void;
}) {
  useUiLocale();
  const copy = MODE_COPY[row.mode] || MODE_COPY.draft_for_approval;
  const toneBadge: Record<typeof copy.tone, 'green' | 'secondary' | 'amber'> = {
    safe: 'green',
    caution: 'amber',
    danger: 'secondary',
  };
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{row.issue_type}</span>
          <Badge variant={toneBadge[copy.tone] as any}>{copy.label}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{copy.desc}</p>
      </div>
      <Select value={row.mode} onChange={(e) => onChange(e.target.value as Mode)} className="w-52 shrink-0">
        {MODES.map((m) => <option key={m} value={m}>{MODE_COPY[m].label}</option>)}
      </Select>
      {canRemove && (
        <Button size="sm" variant="ghost" onClick={onRemove}>{uiText("Remove")}</Button>
      )}
    </div>
  );
}
