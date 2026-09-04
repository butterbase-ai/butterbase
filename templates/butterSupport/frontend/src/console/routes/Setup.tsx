import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/console/lib/api';
import { APP_ID, bb, SUBDOMAIN } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Input } from '@/console/components/ui/input';
import { Select } from '@/console/components/ui/select';
import { cn } from '@/console/lib/utils';

const STEPS = ['Knowledge', 'Widget', 'Escalation'];

export function Setup() {
  const [step, setStep] = useState(1);
  const navigate = useNavigate();

  // step 1
  const [docsUrl, setDocsUrl] = useState('');
  const [docsName, setDocsName] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [docsErr, setDocsErr] = useState<string | null>(null);

  // step 3
  const [channel, setChannel] = useState<'slack' | 'email'>('email');
  const [target, setTarget] = useState('');

  async function ingest() {
    setIngesting(true); setDocsErr(null);
    try {
      await api.ingestDocs({ url: docsUrl, source_kind: 'web', display_name: docsName || docsUrl });
      setStep(2);
    } catch (e: any) {
      setDocsErr(e?.message || 'Ingestion failed');
    } finally {
      setIngesting(false);
    }
  }

  async function saveEscalation() {
    const config = channel === 'slack' ? { slack_channel: target } : { email: target };
    await bb.from('escalation_targets').insert({ channel, config, is_default: true });
    navigate('/inbox', { replace: true });
  }

  const snippet = `<script async src="https://${SUBDOMAIN}.butterbase.dev/widget.js" data-app-id="${APP_ID}"></script>`;

  return (
    <div className="paper-grain flex min-h-screen items-center justify-center p-6 bg-background">
      <div className="w-[680px] max-w-full">
        {/* Stepper */}
        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((label, i) => {
            const idx = i + 1;
            const active = idx === step;
            const done = idx < step;
            return (
              <div key={label} className="flex items-center gap-2">
                <div
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px]',
                    active && 'bg-foreground text-background',
                    done && 'border border-sage/30 bg-sage/10 text-sage',
                    !active && !done && 'border border-border text-muted-foreground',
                  )}
                >
                  <span className="font-mono text-[10px] num">
                    {done ? '✓' : idx}
                  </span>
                  <span className="uppercase tracking-wider font-semibold">{label}</span>
                </div>
                {i < STEPS.length - 1 && (
                  <span className={cn('h-px w-6', done ? 'bg-sage/40' : 'bg-border')} />
                )}
              </div>
            );
          })}
        </div>

        <div className="card-flat p-10">
          <p className="eyebrow mb-3">Setup · {step} of {STEPS.length}</p>
          <h1 className="page-title">
            {step === 1 && <>Feed the agent your <em>knowledge</em>.</>}
            {step === 2 && <>Drop the widget into your <em>site</em>.</>}
            {step === 3 && <>Where should we <em>escalate</em>?</>}
          </h1>

          <div className="mt-7 space-y-4">
            {step === 1 && (
              <>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Paste a help-center URL. We'll crawl, chunk, and embed it so the agent can answer using your docs.
                </p>
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Display name · optional</label>
                  <Input className="mt-2" value={docsName} onChange={(e) => setDocsName(e.target.value)} placeholder="Help center" />
                </div>
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">URL</label>
                  <Input className="mt-2" value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} placeholder="https://docs.yourcompany.com" />
                </div>
                {docsErr && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">{docsErr}</div>
                )}
                <div className="flex items-center gap-3 pt-1">
                  <Button onClick={ingest} disabled={!docsUrl || ingesting} size="lg">
                    {ingesting ? 'Ingesting…' : 'Ingest & continue'}
                  </Button>
                  <button
                    className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground hover:text-caramel transition-colors"
                    onClick={() => setStep(2)}
                  >
                    Skip for now →
                  </button>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Drop this snippet on your site. Works for anyone — logged in or not. No server code required.
                </p>
                <pre className="rounded-xl border border-rule-soft bg-paper-warm p-4 font-mono text-xs overflow-x-auto whitespace-pre-wrap text-caramel-deep/90">{snippet}</pre>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Once a user logs in, optionally call{' '}
                  <code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">
                    ButterSupport.identify(&#123;user_id, email, name&#125;)
                  </code>{' '}
                  to attach their identity to future tickets. Full details on the Widget settings page.
                </p>
                <div className="pt-1">
                  <Button onClick={() => setStep(3)} size="lg">Continue →</Button>
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  Where should the agent escalate tickets it can't handle on its own?
                </p>
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Channel</label>
                  <Select className="mt-2" value={channel} onChange={(e) => setChannel(e.target.value as any)}>
                    <option value="email">Email</option>
                    <option value="slack">Slack</option>
                  </Select>
                </div>
                <div>
                  <label className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    {channel === 'slack' ? 'Slack channel · e.g. #support' : 'Email address'}
                  </label>
                  <Input className="mt-2" value={target} onChange={(e) => setTarget(e.target.value)} />
                </div>
                <div className="pt-1">
                  <Button onClick={saveEscalation} disabled={!target} size="lg">
                    Finish setup ✨
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
