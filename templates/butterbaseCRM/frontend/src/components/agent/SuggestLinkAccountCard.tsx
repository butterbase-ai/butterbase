import { uiText, uiMessage, useUiLocale } from "../../i18n";
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { bb } from '@/lib/butterbase';

interface Props { provider: 'gmail' | 'google-calendar'; reason: string; onLinked: () => void }

export function SuggestLinkAccountCard({ provider, reason, onLinked }: Props) {
  useUiLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const result = await (bb as any).integrations.connect(provider, {
        redirectUrl: `${window.location.origin}/integrations/callback`,
      });
      const data = result?.data ?? result;
      const authUrl: string | undefined = data?.authUrl;
      if (!authUrl) throw new Error(uiText('no_auth_url'));
      const popup = window.open(authUrl, 'integration-oauth', 'width=540,height=720');
      if (!popup) throw new Error(uiText('popup_blocked'));
      const onMsg = (e: MessageEvent) => {
        if (e.data === 'integration_connected') {
          window.removeEventListener('message', onMsg);
          popup.close();
          onLinked();
        }
      };
      window.addEventListener('message', onMsg);
    } catch (e: any) {
      setError(e?.message ?? uiText('failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-2">
      <p className="text-[13.5px]">{uiText("Link ")}{provider.replace('-', ' ')} — <span className="text-muted-foreground">{reason}</span></p>
      <Button size="sm" onClick={start} disabled={busy}>{busy ? uiText('Opening…') : uiMessage`Link ${provider}`}</Button>
      {error && <p className="text-[12px] text-coral font-mono">{error}</p>}
    </div>
  );
}
