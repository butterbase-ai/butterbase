import { useMemo, useState } from 'react';
import { APP_ID, SUBDOMAIN } from '@/console/lib/bb';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';

interface Section {
  id: string;
  title: string;
  body: React.ReactNode;
}

export function Docs() {
  const [query, setQuery] = useState('');

  const base = `https://${SUBDOMAIN}.butterbase.dev`;

  const installSnippet =
    `<script async src="${base}/widget.js" data-app-id="${APP_ID}"></script>`;

  const identifySnippet = `<script>
  window.ButterSupport = window.ButterSupport || { q: [] };
  ButterSupport.q.push(['identify', {
    user_id: 'your-internal-user-id',
    email:   'user@example.com',
    name:    'Ada Lovelace',
  }]);
</script>`;

  const sections: Section[] = useMemo(() => [
    {
      id: 'what-is',
      title: 'What Butter Support is',
      body: (
        <>
          <p>
            Butter Support is a self-hosted AI customer-support tool. A small widget on your site
            captures questions from visitors (logged in or not), an agent drafts or sends replies
            grounded in your help docs, and everything not handled cleanly lands in your console
            as a ticket for you or your team to take over.
          </p>
          <p>The core loop is:</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li><strong>Customer</strong> sends a message via the widget.</li>
            <li><strong>Agent</strong> retrieves relevant docs, drafts a reply, and either sends it
              automatically or queues it for your approval — whichever the autonomy mode is set to.</li>
            <li>The ticket lives in <a href="/inbox" className="underline">Inbox</a> with full thread,
              activity log, and one-click escalation to a human teammate.</li>
          </ol>
        </>
      ),
    },
    {
      id: 'install',
      title: 'Install the widget on your site',
      body: (
        <>
          <p>
            The minimum install is one line, dropped on any page (logged-in or anonymous visitor — both work):
          </p>
          <pre className="rounded-md border border-border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">{installSnippet}</pre>
          <p>
            The widget renders a launcher in the bottom-right corner. Conversations persist via a
            <code className="mx-1 rounded bg-muted px-1">visitor_token</code> stored in the
            visitor's localStorage — no cookies, no server code, no auth dance.
          </p>
          <p className="text-sm text-muted-foreground">
            Works on any origin (Webflow, WordPress, Next.js, plain HTML…). The widget's
            <code className="mx-1 rounded bg-muted px-1">fetch</code> calls go cross-origin to
            <code className="mx-1 rounded bg-muted px-1">api.butterbase.ai</code> with permissive CORS.
          </p>
        </>
      ),
    },
    {
      id: 'identify',
      title: 'Identifying logged-in users (optional)',
      body: (
        <>
          <p>
            After your user signs in, call <code className="rounded bg-muted px-1">identify()</code> to stamp
            their name/email onto future tickets:
          </p>
          <pre className="rounded-md border border-border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">{identifySnippet}</pre>
          <p>
            Pre-load queueing is supported — push to <code className="rounded bg-muted px-1">window.ButterSupport.q</code> before
            the bundle loads and the call is replayed once the widget mounts.
          </p>
          <p className="text-sm text-muted-foreground">
            Identity is currently unverified (we trust whatever the host page hands us). For most
            v1 use cases that's fine; if you ever need signed identity, that's a future addition
            (HMAC userHash, similar to Intercom).
          </p>
        </>
      ),
    },
    {
      id: 'js-api',
      title: 'JavaScript API',
      body: (
        <>
          <p>Once the widget mounts, these methods are available on <code className="rounded bg-muted px-1">window.ButterSupport</code>:</p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">Method</th>
                <th className="py-2 font-medium">What it does</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <Row code="identify({ user_id, email, name })" desc="Attach identity to future tickets in this session." />
              <Row code="open()" desc="Open the panel programmatically." />
              <Row code="close()" desc="Close the panel." />
              <Row code="toggle()" desc="Toggle the panel — useful for custom launcher buttons." />
              <Row code="reset()" desc="Clear identity + active ticket. Call on logout." />
              <Row code="q.push([method, ...args])" desc="Queue a call before the bundle loads. Replayed on mount." />
            </tbody>
          </table>
        </>
      ),
    },
    {
      id: 'auto-reply',
      title: 'How auto-reply works',
      body: (
        <>
          <p>
            When a new ticket lands via <code className="rounded bg-muted px-1">widget-ingest</code>, an internal
            <code className="mx-1 rounded bg-muted px-1">auto-reply-worker</code> function fires
            in the background. It:
          </p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Reads the active autonomy mode (per <code className="rounded bg-muted px-1">issue_type</code> override, else the
              default in <a href="/settings/autonomy" className="underline">Settings → Autonomy</a>).</li>
            <li>Reads your style preferences from <a href="/settings/skill" className="underline">Settings → Skill</a>.</li>
            <li>RAG-retrieves the top 5 chunks from your <code className="rounded bg-muted px-1">support-docs</code> collection
              based on the customer's message.</li>
            <li>Sends a single chat-completion to <code className="rounded bg-muted px-1">anthropic/claude-haiku-4.5</code>
              asking for a JSON object <code className="rounded bg-muted px-1">{`{subject, reply}`}</code>.</li>
            <li>Updates the ticket's <code className="rounded bg-muted px-1">subject</code> if it was empty.</li>
            <li>Writes the reply into <code className="rounded bg-muted px-1">support_messages</code> with the right role for the mode.</li>
            <li>Logs an <code className="rounded bg-muted px-1">activities</code> row capturing model, chunks used, and the generated subject.</li>
          </ol>
          <p>End-to-end customer-message-to-reply latency is typically ~5s server-side; the widget's 5s poll surfaces it within ~10s in the panel.</p>
          <p className="text-sm text-muted-foreground">
            Cost per reply with the default model is roughly $0.001 — claude-haiku + embed + 5-chunk retrieve.
          </p>
        </>
      ),
    },
    {
      id: 'autonomy',
      title: 'Autonomy modes',
      body: (
        <>
          <p>
            The agent's behaviour on a new message is governed by the autonomy mode. Set the default and
            per-issue-type overrides in <a href="/settings/autonomy" className="underline">Settings → Autonomy</a>.
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">Mode</th>
                <th className="py-2 pr-3 font-medium">Message role written</th>
                <th className="py-2 font-medium">Resulting ticket status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <Row3 a="draft_for_approval" b="agent_draft (hidden from customer)" c="awaiting_approval" />
              <Row3 a="auto_send" b="founder (visible to customer)" c="open" />
              <Row3 a="auto_resolve" b="founder (visible to customer)" c="resolved" />
            </tbody>
          </table>
          <p className="text-sm text-muted-foreground">
            If the AI call fails, the worker writes an <code className="rounded bg-muted px-1">auto_reply.failed</code> activity
            and leaves the ticket <code className="rounded bg-muted px-1">open</code> so it shows up in the inbox for you to handle.
          </p>
        </>
      ),
    },
    {
      id: 'docs',
      title: 'Feeding the agent your help docs',
      body: (
        <>
          <p>
            The agent's answers are only as good as the docs it retrieves. Manage your sources in
            <a href="/settings/docs" className="underline mx-1">Settings → Docs</a>.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Web URL</strong> — ingest a help-centre page. We crawl, chunk, and embed it
              into the <code className="rounded bg-muted px-1">support-docs</code> RAG collection.</li>
            <li><strong>File upload</strong> — PDF, MD, TXT, HTML, CSV, JSON. We presign a PUT URL, ingest after upload.</li>
            <li><strong>Refresh</strong> — a cron re-crawls web sources weekly and reindexes any changed pages.</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Until the collection has reasonable coverage, the AI will hit the "no docs" branch of the
            system prompt and politely offer to escalate. That's by design — better than hallucination.
          </p>
        </>
      ),
    },
    {
      id: 'skill',
      title: 'Tuning the agent\'s voice',
      body: (
        <>
          <p>
            Style and behaviour live in <a href="/settings/skill" className="underline">Settings → Skill</a> and are
            included in the system prompt on every auto-reply call. Knobs:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>tone</strong> — e.g. <em>warm_professional</em>, <em>casual</em>, <em>formal</em></li>
            <li><strong>formality</strong>, <strong>response_length</strong>, <strong>always_cite</strong>, <strong>sales_posture</strong></li>
            <li><strong>freeform_context</strong> — anything else (brand name, taglines, escalation guidance, things to never say)</li>
          </ul>
        </>
      ),
    },
    {
      id: 'inbox',
      title: 'Inbox & ticket lifecycle',
      body: (
        <>
          <p>
            <a href="/inbox" className="underline">Inbox</a> shows every ticket grouped by status.
            A ticket transitions through these statuses:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">open</code> — customer message arrived, awaiting reply (manual or auto_send).</li>
            <li><code className="rounded bg-muted px-1">awaiting_approval</code> — agent drafted a reply; you approve in <em>Ticket Detail → Draft</em>.</li>
            <li><code className="rounded bg-muted px-1">awaiting_customer</code> — you replied; waiting on the customer.</li>
            <li><code className="rounded bg-muted px-1">resolved</code> — closed cleanly (auto or manual).</li>
            <li><code className="rounded bg-muted px-1">escalated</code> — handed off to a human via Slack/email per your escalation target.</li>
          </ul>
        </>
      ),
    },
    {
      id: 'escalation',
      title: 'Escalation',
      body: (
        <p>
          Configure where escalations go in <a href="/settings/escalation" className="underline">Settings → Escalation</a>
          — Slack channel or email address. When the agent escalates a ticket (or you click <em>Escalate</em>
          in the ticket detail), the <code className="rounded bg-muted px-1">execute-escalation</code> function
          sends a message via the configured channel with a link back to the ticket.
        </p>
      ),
    },
    {
      id: 'architecture',
      title: 'Architecture at a glance',
      body: (
        <>
          <p>Three planes:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>Widget</strong> (customer's browser) → <code className="rounded bg-muted px-1">widget-*</code> public functions on Butterbase.</li>
            <li><strong>Console</strong> (you / your team) → Butterbase auto-API + admin functions, RLS-gated by membership role.</li>
            <li><strong>Agent</strong> (server-side) → <code className="rounded bg-muted px-1">auto-reply-worker</code> calling AI gateway + RAG.</li>
          </ul>
          <p>Data tables of note:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">support_tickets</code>, <code className="rounded bg-muted px-1">support_messages</code> — the conversation.</li>
            <li><code className="rounded bg-muted px-1">agent_threads</code>, <code className="rounded bg-muted px-1">agent_messages</code> — agent run state.</li>
            <li><code className="rounded bg-muted px-1">agent_proposals</code> — pending actions (e.g. drafts) awaiting approval.</li>
            <li><code className="rounded bg-muted px-1">diagnoses</code>, <code className="rounded bg-muted px-1">pattern_signals</code> — long-term learning.</li>
            <li><code className="rounded bg-muted px-1">activities</code> — audit log of everything that happens to a ticket.</li>
            <li><code className="rounded bg-muted px-1">autonomy_settings</code>, <code className="rounded bg-muted px-1">support_skill</code>, <code className="rounded bg-muted px-1">escalation_targets</code> — configuration.</li>
            <li><code className="rounded bg-muted px-1">docs_sources</code> — registered help-doc inputs (the RAG collection itself is in Butterbase RAG).</li>
          </ul>
        </>
      ),
    },
    {
      id: 'functions',
      title: 'Function reference',
      body: (
        <>
          <p className="text-sm text-muted-foreground">All paths are relative to <code className="rounded bg-muted px-1">https://api.butterbase.ai/v1/{APP_ID}/fn/</code>.</p>
          <h4 className="mt-3 font-medium">Public (widget)</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">POST widget-ingest</code> — open a new ticket. Body: <code>{`{visitor_token, body, subject?, identity?, client_message_id?}`}</code></li>
            <li><code className="rounded bg-muted px-1">POST widget-followup</code> — add a message to an existing ticket.</li>
            <li><code className="rounded bg-muted px-1">POST widget-fetch-history</code> — list this visitor's tickets, or a single ticket's messages.</li>
            <li><code className="rounded bg-muted px-1">POST widget-poll-replies</code> — pull new founder/system messages newer than a cursor.</li>
          </ul>
          <h4 className="mt-3 font-medium">Internal</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">POST auto-reply-worker</code> — fires on every new ticket, gated by an internal bearer token.</li>
            <li><code className="rounded bg-muted px-1">POST execute-escalation</code> — substrate outbox handler for human-handoff.</li>
          </ul>
          <h4 className="mt-3 font-medium">Admin (console-only)</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">send-draft-reply</code>, <code className="rounded bg-muted px-1">approve-proposal</code>, <code className="rounded bg-muted px-1">reject-proposal</code></li>
            <li><code className="rounded bg-muted px-1">ingest-docs</code>, <code className="rounded bg-muted px-1">delete-docs-source</code>, <code className="rounded bg-muted px-1">request-doc-upload-url</code>, <code className="rounded bg-muted px-1">refresh-docs</code> (cron)</li>
            <li><code className="rounded bg-muted px-1">invite-teammate</code>, <code className="rounded bg-muted px-1">remove-teammate</code></li>
            <li><code className="rounded bg-muted px-1">fetch-ai-usage</code>, <code className="rounded bg-muted px-1">ask-support-overview</code></li>
          </ul>
        </>
      ),
    },
    {
      id: 'security',
      title: 'Security model',
      body: (
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>Widget endpoints</strong> are public (auth: none). Authorization is by <code className="rounded bg-muted px-1">visitor_token</code>
            scoping in the function (server filters every query by the token). CORS is open because the threat model is per-visitor isolation, not origin gating.</li>
          <li><strong>Admin endpoints</strong> require a valid end-user JWT and are RLS-gated to membership-bearing users.</li>
          <li><strong>Sensitive tables</strong> (<code className="rounded bg-muted px-1">autonomy_settings</code>, <code className="rounded bg-muted px-1">escalation_targets</code>, <code className="rounded bg-muted px-1">app_allowlist</code>, etc.) restrict writes to owner/admin via RLS.</li>
          <li><strong>Internal worker</strong> calls (<code className="rounded bg-muted px-1">widget-ingest → auto-reply-worker</code>) are gated by a shared bearer token in env, not by origin.</li>
          <li><strong>AI key</strong> is scoped to <code className="rounded bg-muted px-1">ai:gateway</code> only and lives in the worker's encrypted env vars.</li>
        </ul>
      ),
    },
    {
      id: 'troubleshoot',
      title: 'Troubleshooting',
      body: (
        <>
          <p><strong>Widget launcher doesn't appear.</strong> Open the browser console and look for <code className="rounded bg-muted px-1">[ButterSupport] no app id</code> — the <code className="rounded bg-muted px-1">data-app-id</code> attribute is missing or the script tag was injected without it. Verify the snippet on Settings → Widget matches what's on your page.</p>
          <p><strong>Visitor's conversation resets every reload.</strong> The widget needs <code className="rounded bg-muted px-1">localStorage</code>. Private browsing, locked-down iframes, and some browser extensions block it — the widget falls back to in-memory tokens (one-session-only) when that happens.</p>
          <p><strong>AI doesn't reply.</strong> Check <code className="rounded bg-muted px-1">activities</code> for the ticket — look for <code className="rounded bg-muted px-1">auto_reply.failed</code>. The <code className="rounded bg-muted px-1">payload.error</code> field tells you whether it was an AI gateway error, an RAG miss, or a network glitch.</p>
          <p><strong>AI keeps saying "I don't have docs."</strong> The <code className="rounded bg-muted px-1">support-docs</code> collection is empty or doesn't cover the topic. Add sources in Settings → Docs and wait for ingestion to complete.</p>
          <p><strong>Customer message doesn't show in the panel.</strong> Verified-fixed in widget v2 — the poll merge used to strip local optimistic messages. If you see this again, the deployed <code className="rounded bg-muted px-1">widget.js</code> may be stale; re-deploy.</p>
        </>
      ),
    },
    {
      id: 'faq',
      title: 'FAQ',
      body: (
        <>
          <p><strong>Q. Does the widget work for visitors who aren't logged in?</strong><br />Yes — that's the default. A visitor token is minted on first load, stored in localStorage, and used to scope the conversation. No host-side auth required.</p>
          <p><strong>Q. Can two devices share a conversation?</strong><br />Not today. The visitor token is per-browser. Cross-device continuity needs signed identity (future work).</p>
          <p><strong>Q. What happens if the customer reopens a resolved ticket?</strong><br />A follow-up message flips the ticket from <code className="rounded bg-muted px-1">resolved</code> back to <code className="rounded bg-muted px-1">open</code> automatically.</p>
          <p><strong>Q. How do I switch to manual approval before the AI replies to anyone?</strong><br />Settings → Autonomy → set default to <code className="rounded bg-muted px-1">draft_for_approval</code>. The agent will keep drafting; nothing reaches customers without your click.</p>
          <p><strong>Q. Can I host the widget on multiple domains?</strong><br />Yes. CORS on the widget endpoints is open. Same script, same app id, any host.</p>
        </>
      ),
    },
  ], [base, installSnippet, identifySnippet]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sections;
    const q = query.toLowerCase();
    return sections.filter((s) => s.title.toLowerCase().includes(q));
  }, [query, sections]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="grid grid-cols-[240px_1fr] gap-12 px-8 py-8 max-w-6xl mx-auto">
        <aside className="sticky top-8 self-start">
          <div className="section-label mb-3">Operator's guide</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter sections…"
            className="w-full rounded-xl border border-rule bg-paper-warm px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-butter-300/60 outline-none mb-4 transition-colors"
          />
          <nav className="space-y-0.5">
            {filtered.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-caramel hover:bg-butter-50 transition-colors"
              >
                <span className="text-caramel/30 group-hover:text-caramel transition-colors">▲</span>
                {s.title}
              </a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          <header className="mb-10">
            <p className="eyebrow mb-3">Docs</p>
            <h1 className="page-title">
              Operator's <em>guide</em>
            </h1>
            <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-xl">
              Install, configure, and operate the Butter Support agent. Every recipe needs a good cookbook.
            </p>
          </header>

          <div className="space-y-6">
            {filtered.map((s) => (
              <Card key={s.id} id={s.id} className="scroll-mt-8">
                <CardHeader>
                  <CardTitle>
                    <a href={`#${s.id}`} className="hover:text-butter transition-colors">{s.title}</a>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm leading-6 text-foreground/85 [&_p]:my-0 [&_a]:text-butter [&_a]:underline [&_a]:decoration-dotted [&_a]:underline-offset-2">
                  {s.body}
                </CardContent>
              </Card>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground">No sections match &ldquo;{query}&rdquo;.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ code, desc }: { code: string; desc: string }) {
  return (
    <tr>
      <td className="py-2 pr-4 align-top"><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded text-xs">{code}</code></td>
      <td className="py-2 align-top text-muted-foreground">{desc}</td>
    </tr>
  );
}

function Row3({ a, b, c }: { a: string; b: string; c: string }) {
  return (
    <tr>
      <td className="py-2 pr-4 align-top"><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded text-xs">{a}</code></td>
      <td className="py-2 pr-4 align-top text-muted-foreground">{b}</td>
      <td className="py-2 align-top text-muted-foreground">{c}</td>
    </tr>
  );
}
