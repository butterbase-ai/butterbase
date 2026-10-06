import { useState } from 'react';
import { APP_ID, SUBDOMAIN } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { SettingsPage } from '@/console/components/SettingsPage';
import { Check, Copy } from 'lucide-react';

export function WidgetSettings() {
  const [copied, setCopied] = useState<string | null>(null);

  const base = `https://${SUBDOMAIN}.butterbase.dev`;

  const installSnippet =
    `<script async src="${base}/widget.js" data-app-id="${APP_ID}"></script>`;

  const identifySnippet = `<script>
  // Optional. Call after your user logs in so tickets show their name + email.
  // Anonymous visitors work without this — they get a cookie-keyed session.
  window.ButterSupport = window.ButterSupport || { q: [] };
  ButterSupport.q.push(['identify', {
    user_id: 'your-internal-user-id',
    email:   'user@example.com',
    name:    'Ada Lovelace',
  }]);
</script>`;

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    });
  }

  const Snippet = ({ code, label }: { code: string; label: string }) => (
    <div className="relative group">
      <pre className="rounded-xl border border-rule-soft bg-paper-warm p-4 font-mono text-xs overflow-x-auto whitespace-pre-wrap text-caramel-deep/90 pr-12">{code}</pre>
      <button
        onClick={() => copy(label, code)}
        className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg border border-rule bg-paper-soft text-muted-foreground hover:text-caramel hover:border-butter-300/60 transition-colors"
        aria-label="Copy snippet"
      >
        {copied === label ? <Check className="h-3.5 w-3.5 text-positive" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );

  return (
    <SettingsPage
      label="Widget"
      title={<>Install the <em>widget</em></>}
      description="Two lines. Works for logged-in and logged-out visitors. No server code required."
    >
      <Card>
        <CardHeader><CardTitle><span className="font-mono text-caramel mr-2">01</span>Drop this on every page</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Snippet code={installSnippet} label="install" />
          <p className="text-xs text-muted-foreground">
            That's it for anonymous visitors. Conversations persist via the visitor's browser.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle><span className="font-mono text-caramel mr-2">02</span>Optional · identify logged-in users</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Add this anywhere after the user logs in. Tickets will be stamped with their name + email.
          </p>
          <Snippet code={identifySnippet} label="identify" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>JavaScript API</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">Once the widget loads, these methods are available on <code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">window.ButterSupport</code>:</p>
          <ul className="space-y-2 text-muted-foreground">
            <li className="flex gap-2"><span className="text-caramel mt-0.5">▲</span><span><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">identify(&#123; user_id, email, name &#125;)</code> — attach identity to future tickets</span></li>
            <li className="flex gap-2"><span className="text-caramel mt-0.5">▲</span><span><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">open()</code> / <code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">close()</code> / <code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">toggle()</code> — control the panel</span></li>
            <li className="flex gap-2"><span className="text-caramel mt-0.5">▲</span><span><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">reset()</code> — clear identity (call this on logout)</span></li>
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Calls made before the bundle loads can be queued via <code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded">window.ButterSupport.q.push([method, ...args])</code> — they'll be replayed once the widget mounts.
          </p>
        </CardContent>
      </Card>
    </SettingsPage>
  );
}
