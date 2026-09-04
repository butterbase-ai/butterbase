import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Select } from '@/console/components/ui/select';
import { Textarea } from '@/console/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { SettingsPage } from '@/console/components/SettingsPage';
import { toast } from '@/console/components/ui/toast';

type Dimensions = {
  tone?: string;
  formality?: string;
  response_length?: string;
  always_cite?: string;
  sales_posture?: string;
};

type SkillRow = {
  singleton: boolean;
  dimensions: Dimensions;
  freeform_context: string | null;
  version: number;
  updated_at: string;
};

const TONE_OPTS = ['warm_professional', 'friendly_casual', 'precise_formal', 'playful'];
const FORMALITY_OPTS = ['casual', 'balanced', 'formal'];
const LENGTH_OPTS = ['terse', 'balanced', 'thorough'];
const CITE_OPTS = ['yes', 'when_helpful', 'no'];
const POSTURE_OPTS = ['help_first', 'upsell_aware', 'sales_forward'];

const DEFAULTS: Required<Dimensions> = {
  tone: 'warm_professional',
  formality: 'balanced',
  response_length: 'balanced',
  always_cite: 'yes',
  sales_posture: 'help_first',
};

function label(s: string) {
  return s.replace(/_/g, ' ');
}

export function SkillSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['support_skill'],
    queryFn: async () => {
      const res: any = await bb.from('support_skill').select('*').limit(1);
      const row = (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [])[0] as SkillRow | undefined;
      return row || null;
    },
  });

  const [dims, setDims] = useState<Required<Dimensions>>(DEFAULTS);
  const [freeform, setFreeform] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setDims({ ...DEFAULTS, ...(data.dimensions || {}) });
    setFreeform(data.freeform_context || '');
  }, [data]);

  function setDim<K extends keyof Dimensions>(k: K, v: string) {
    setDims((d) => ({ ...d, [k]: v }));
  }

  async function save() {
    setBusy(true);
    try {
      await bb
        .from('support_skill')
        .update({
          dimensions: dims,
          freeform_context: freeform,
          version: (data?.version ?? 1) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('singleton', true);
      setSavedAt(new Date().toLocaleTimeString());
      qc.invalidateQueries({ queryKey: ['support_skill'] });
    } catch (e: any) {
      toast.error(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    !!data &&
    (freeform !== (data.freeform_context || '') ||
      JSON.stringify(dims) !== JSON.stringify({ ...DEFAULTS, ...(data.dimensions || {}) }));

  return (
    <SettingsPage
      label="Skills"
      title={<>Agent <em>personality</em></>}
      description="Tone, formality, citation discipline, and freeform context — all injected into the agent's prompts."
    >

      <Card>
        <CardHeader>
          <CardTitle>Behavioral dimensions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            These shape the agent's tone and posture. They are injected into every reply prompt.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field name="Tone">
              <Select value={dims.tone} onChange={(e) => setDim('tone', e.target.value)}>
                {TONE_OPTS.map((o) => <option key={o} value={o}>{label(o)}</option>)}
              </Select>
            </Field>
            <Field name="Formality">
              <Select value={dims.formality} onChange={(e) => setDim('formality', e.target.value)}>
                {FORMALITY_OPTS.map((o) => <option key={o} value={o}>{label(o)}</option>)}
              </Select>
            </Field>
            <Field name="Response length">
              <Select value={dims.response_length} onChange={(e) => setDim('response_length', e.target.value)}>
                {LENGTH_OPTS.map((o) => <option key={o} value={o}>{label(o)}</option>)}
              </Select>
            </Field>
            <Field name="Always cite sources">
              <Select value={dims.always_cite} onChange={(e) => setDim('always_cite', e.target.value)}>
                {CITE_OPTS.map((o) => <option key={o} value={o}>{label(o)}</option>)}
              </Select>
            </Field>
            <Field name="Sales posture">
              <Select value={dims.sales_posture} onChange={(e) => setDim('sales_posture', e.target.value)}>
                {POSTURE_OPTS.map((o) => <option key={o} value={o}>{label(o)}</option>)}
              </Select>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>Freeform context</span>
            <span
              title="Temporary knowledge you want the AI agent to have — anything the agent should know that isn't in your docs (product caveats, current promotions, phrases to prefer or avoid). Appended verbatim to the prompt."
              className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] font-medium text-muted-foreground"
              aria-label="About freeform context"
            >
              ?
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            rows={8}
            placeholder="e.g. We are running a 20% off summer promo through July 15. Don't mention pricing tiers above $99 — those are enterprise-only."
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 pt-1">
        <Button onClick={save} disabled={!dirty || busy || isLoading}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
        <div className="font-mono text-[11px] text-muted-foreground">
          {data && <>v{data.version} · updated {new Date(data.updated_at).toLocaleString()}</>}
          {savedAt && <span className="ml-2 text-positive">saved at {savedAt}</span>}
        </div>
      </div>
    </SettingsPage>
  );
}

function Field({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{name}</span>
      {children}
    </label>
  );
}
