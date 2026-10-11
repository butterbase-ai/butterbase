import { uiText, useUiLocale } from "../../i18n";
import { useMemo, useState } from 'react';
import { APP_ID, SUBDOMAIN } from '@/console/lib/bb';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';

interface Section {
  id: string;
  title: string;
  body: React.ReactNode;
}

export function Docs() {
  const uiLocale = useUiLocale();
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
      get title() { return uiText('What Butter Support is'); },
      body: (
        <>
          <p>
            {uiText("Butter Support is a self-hosted AI customer-support tool. A small widget on your site captures questions from visitors (logged in or not), an agent drafts or sends replies grounded in your help docs, and everything not handled cleanly lands in your console as a ticket for you or your team to take over.")}</p>
          <p>{uiText("The core loop is:")}</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li><strong>{uiText("Customer")}</strong> {uiText(" sends a message via the widget.")}</li>
            <li><strong>{uiText("Agent")}</strong> {uiText(" retrieves relevant docs, drafts a reply, and either sends it automatically or queues it for your approval — whichever the autonomy mode is set to.")}</li>
            <li>{uiText("The ticket lives in ")}<a href="/inbox" className="underline">{uiText("Inbox")}</a> {uiText(" with full thread, activity log, and one-click escalation to a human teammate.")}</li>
          </ol>
        </>
      ),
    },
    {
      id: 'install',
      get title() { return uiText('Install the widget on your site'); },
      body: (
        <>
          <p>
            {uiText("The minimum install is one line, dropped on any page (logged-in or anonymous visitor — both work):")}</p>
          <pre className="rounded-md border border-border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">{installSnippet}</pre>
          <p>
            {uiText("The widget renders a launcher in the bottom-right corner. Conversations persist via a")}<code className="mx-1 rounded bg-muted px-1">visitor_token</code> {uiText(" stored in the visitor's localStorage — no cookies, no server code, no auth dance.")}</p>
          <p className="text-sm text-muted-foreground">
            {uiText("Works on any origin (Webflow, WordPress, Next.js, plain HTML…). The widget's")}<code className="mx-1 rounded bg-muted px-1">fetch</code> {uiText(" calls go cross-origin to")}<code className="mx-1 rounded bg-muted px-1">api.butterbase.ai</code> {uiText(" with permissive CORS.")}</p>
        </>
      ),
    },
    {
      id: 'identify',
      get title() { return uiText('Identifying logged-in users (optional)'); },
      body: (
        <>
          <p>
            {uiText("After your user signs in, call ")}<code className="rounded bg-muted px-1">identify()</code> {uiText(" to stamp their name/email onto future tickets:")}</p>
          <pre className="rounded-md border border-border bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">{identifySnippet}</pre>
          <p>
            {uiText("Pre-load queueing is supported — push to ")}<code className="rounded bg-muted px-1">window.ButterSupport.q</code> {uiText(" before the bundle loads and the call is replayed once the widget mounts.")}</p>
          <p className="text-sm text-muted-foreground">
            {uiText("Identity is currently unverified (we trust whatever the host page hands us). For most v1 use cases that's fine; if you ever need signed identity, that's a future addition (HMAC userHash, similar to Intercom).")}</p>
        </>
      ),
    },
    {
      id: 'js-api',
      title: 'JavaScript API',
      body: (
        <>
          <p>{uiText("Once the widget mounts, these methods are available on ")}<code className="rounded bg-muted px-1">window.ButterSupport</code>:</p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">{uiText("Method")}</th>
                <th className="py-2 font-medium">{uiText("What it does")}</th>
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
      get title() { return uiText('How auto-reply works'); },
      body: (
        <>
          <p>
            {uiText("When a new ticket lands via ")}<code className="rounded bg-muted px-1">widget-ingest</code>{uiText(", an internal")}<code className="mx-1 rounded bg-muted px-1">auto-reply-worker</code> {uiText(" function fires in the background. It:")}</p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>{uiText("Reads the active autonomy mode (per ")}<code className="rounded bg-muted px-1">issue_type</code> {uiText(" override, else the default in ")}<a href="/settings/autonomy" className="underline">{uiText("Settings → Autonomy")}</a>).</li>
            <li>{uiText("Reads your style preferences from ")}<a href="/settings/skill" className="underline">{uiText("Settings → Skill")}</a>.</li>
            <li>{uiText("RAG-retrieves the top 5 chunks from your ")}<code className="rounded bg-muted px-1">support-docs</code> {uiText(" collection based on the customer's message.")}</li>
            <li>{uiText("Sends a single chat-completion to ")}<code className="rounded bg-muted px-1">anthropic/claude-haiku-4.5</code>
              {uiText("asking for a JSON object ")}<code className="rounded bg-muted px-1">{`{subject, reply}`}</code>.</li>
            <li>{uiText("Updates the ticket's ")}<code className="rounded bg-muted px-1">subject</code> {uiText(" if it was empty.")}</li>
            <li>{uiText("Writes the reply into ")}<code className="rounded bg-muted px-1">support_messages</code> {uiText(" with the right role for the mode.")}</li>
            <li>{uiText("Logs an ")}<code className="rounded bg-muted px-1">activities</code> {uiText(" row capturing model, chunks used, and the generated subject.")}</li>
          </ol>
          <p>{uiText("End-to-end customer-message-to-reply latency is typically ~5s server-side; the widget's 5s poll surfaces it within ~10s in the panel.")}</p>
          <p className="text-sm text-muted-foreground">
            {uiText("Cost per reply with the default model is roughly $0.001 — claude-haiku + embed + 5-chunk retrieve.")}</p>
        </>
      ),
    },
    {
      id: 'autonomy',
      get title() { return uiText('Autonomy modes'); },
      body: (
        <>
          <p>
            {uiText("The agent's behaviour on a new message is governed by the autonomy mode. Set the default and per-issue-type overrides in ")}<a href="/settings/autonomy" className="underline">{uiText("Settings → Autonomy")}</a>.
          </p>
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 font-medium">{uiText("Mode")}</th>
                <th className="py-2 pr-3 font-medium">{uiText("Message role written")}</th>
                <th className="py-2 font-medium">{uiText("Resulting ticket status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <Row3 a="draft_for_approval" b="agent_draft (hidden from customer)" c="awaiting_approval" />
              <Row3 a="auto_send" b="founder (visible to customer)" c="open" />
              <Row3 a="auto_resolve" b="founder (visible to customer)" c="resolved" />
            </tbody>
          </table>
          <p className="text-sm text-muted-foreground">
            {uiText("If the AI call fails, the worker writes an ")}<code className="rounded bg-muted px-1">auto_reply.failed</code> {uiText(" activity and leaves the ticket ")}<code className="rounded bg-muted px-1">open</code> {uiText(" so it shows up in the inbox for you to handle.")}</p>
        </>
      ),
    },
    {
      id: 'docs',
      get title() { return uiText('Feeding the agent your help docs'); },
      body: (
        <>
          <p>
            {uiText("The agent's answers are only as good as the docs it retrieves. Manage your sources in")}<a href="/settings/docs" className="underline mx-1">{uiText("Settings → Docs")}</a>.
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>{uiText("Web URL")}</strong> {uiText(" — ingest a help-centre page. We crawl, chunk, and embed it into the ")}<code className="rounded bg-muted px-1">support-docs</code> {uiText(" RAG collection.")}</li>
            <li><strong>{uiText("File upload")}</strong> {uiText(" — PDF, MD, TXT, HTML, CSV, JSON. We presign a PUT URL, ingest after upload.")}</li>
            <li><strong>{uiText("Refresh")}</strong> {uiText(" — a cron re-crawls web sources weekly and reindexes any changed pages.")}</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            {uiText("Until the collection has reasonable coverage, the AI will hit the \"no docs\" branch of the system prompt and politely offer to escalate. That's by design — better than hallucination.")}</p>
        </>
      ),
    },
    {
      id: 'skill',
      get title() { return uiText('Tuning the agent\'s voice'); },
      body: (
        <>
          <p>
            {uiText("Style and behaviour live in ")}<a href="/settings/skill" className="underline">{uiText("Settings → Skill")}</a> {uiText(" and are included in the system prompt on every auto-reply call. Knobs:")}</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>{uiText("tone")}</strong> — e.g. <em>{uiText("warm_professional")}</em>, <em>{uiText("casual")}</em>, <em>{uiText("formal")}</em></li>
            <li><strong>{uiText("formality")}</strong>, <strong>{uiText("response_length")}</strong>, <strong>{uiText("always_cite")}</strong>, <strong>{uiText("sales_posture")}</strong></li>
            <li><strong>{uiText("freeform_context")}</strong> {uiText(" — anything else (brand name, taglines, escalation guidance, things to never say)")}</li>
          </ul>
        </>
      ),
    },
    {
      id: 'inbox',
      get title() { return uiText('Inbox & ticket lifecycle'); },
      body: (
        <>
          <p>
            <a href="/inbox" className="underline">{uiText("Inbox")}</a> {uiText(" shows every ticket grouped by status. A ticket transitions through these statuses:")}</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">open</code> {uiText(" — customer message arrived, awaiting reply (manual or auto_send).")}</li>
            <li><code className="rounded bg-muted px-1">awaiting_approval</code> {uiText(" — agent drafted a reply; you approve in ")}<em>{uiText("Ticket Detail → Draft")}</em>.</li>
            <li><code className="rounded bg-muted px-1">awaiting_customer</code> {uiText(" — you replied; waiting on the customer.")}</li>
            <li><code className="rounded bg-muted px-1">resolved</code> {uiText(" — closed cleanly (auto or manual).")}</li>
            <li><code className="rounded bg-muted px-1">escalated</code> {uiText(" — handed off to a human via Slack/email per your escalation target.")}</li>
          </ul>
        </>
      ),
    },
    {
      id: 'escalation',
      get title() { return uiText('Escalation'); },
      body: (
        <p>
          {uiText("Configure where escalations go in ")}<a href="/settings/escalation" className="underline">{uiText("Settings → Escalation")}</a>
          {uiText("— Slack channel or email address. When the agent escalates a ticket (or you click ")}<em>{uiText("Escalate")}</em>
          {uiText("in the ticket detail), the ")}<code className="rounded bg-muted px-1">execute-escalation</code> {uiText(" function sends a message via the configured channel with a link back to the ticket.")}</p>
      ),
    },
    {
      id: 'architecture',
      get title() { return uiText('Architecture at a glance'); },
      body: (
        <>
          <p>{uiText("Three planes:")}</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><strong>{uiText("Widget")}</strong> {uiText(" (customer's browser) → ")}<code className="rounded bg-muted px-1">widget-*</code> {uiText(" public functions on Butterbase.")}</li>
            <li><strong>{uiText("Console")}</strong> {uiText(" (you / your team) → Butterbase auto-API + admin functions, RLS-gated by membership role.")}</li>
            <li><strong>{uiText("Agent")}</strong> {uiText(" (server-side) → ")}<code className="rounded bg-muted px-1">auto-reply-worker</code> {uiText(" calling AI gateway + RAG.")}</li>
          </ul>
          <p>{uiText("Data tables of note:")}</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">support_tickets</code>, <code className="rounded bg-muted px-1">support_messages</code> {uiText(" — the conversation.")}</li>
            <li><code className="rounded bg-muted px-1">agent_threads</code>, <code className="rounded bg-muted px-1">agent_messages</code> {uiText(" — agent run state.")}</li>
            <li><code className="rounded bg-muted px-1">agent_proposals</code> {uiText(" — pending actions (e.g. drafts) awaiting approval.")}</li>
            <li><code className="rounded bg-muted px-1">diagnoses</code>, <code className="rounded bg-muted px-1">pattern_signals</code> {uiText(" — long-term learning.")}</li>
            <li><code className="rounded bg-muted px-1">activities</code> {uiText(" — audit log of everything that happens to a ticket.")}</li>
            <li><code className="rounded bg-muted px-1">autonomy_settings</code>, <code className="rounded bg-muted px-1">support_skill</code>, <code className="rounded bg-muted px-1">escalation_targets</code> {uiText(" — configuration.")}</li>
            <li><code className="rounded bg-muted px-1">docs_sources</code> {uiText(" — registered help-doc inputs (the RAG collection itself is in Butterbase RAG).")}</li>
          </ul>
        </>
      ),
    },
    {
      id: 'functions',
      get title() { return uiText('Function reference'); },
      body: (
        <>
          <p className="text-sm text-muted-foreground">{uiText("All paths are relative to ")}<code className="rounded bg-muted px-1">https://api.butterbase.ai/v1/{APP_ID}/fn/</code>.</p>
          <h4 className="mt-3 font-medium">{uiText("Public (widget)")}</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">POST widget-ingest</code> {uiText(" — open a new ticket. Body: ")}<code>{`{visitor_token, body, subject?, identity?, client_message_id?}`}</code></li>
            <li><code className="rounded bg-muted px-1">POST widget-followup</code> {uiText(" — add a message to an existing ticket.")}</li>
            <li><code className="rounded bg-muted px-1">POST widget-fetch-history</code> {uiText(" — list this visitor's tickets, or a single ticket's messages.")}</li>
            <li><code className="rounded bg-muted px-1">POST widget-poll-replies</code> {uiText(" — pull new founder/system messages newer than a cursor.")}</li>
          </ul>
          <h4 className="mt-3 font-medium">{uiText("Internal")}</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">POST auto-reply-worker</code> {uiText(" — fires on every new ticket, gated by an internal bearer token.")}</li>
            <li><code className="rounded bg-muted px-1">POST execute-escalation</code> {uiText(" — substrate outbox handler for human-handoff.")}</li>
          </ul>
          <h4 className="mt-3 font-medium">{uiText("Admin (console-only)")}</h4>
          <ul className="list-disc pl-5 space-y-1">
            <li><code className="rounded bg-muted px-1">send-draft-reply</code>, <code className="rounded bg-muted px-1">approve-proposal</code>, <code className="rounded bg-muted px-1">reject-proposal</code></li>
            <li><code className="rounded bg-muted px-1">ingest-docs</code>, <code className="rounded bg-muted px-1">delete-docs-source</code>, <code className="rounded bg-muted px-1">request-doc-upload-url</code>, <code className="rounded bg-muted px-1">refresh-docs</code> {uiText(" (cron)")}</li>
            <li><code className="rounded bg-muted px-1">invite-teammate</code>, <code className="rounded bg-muted px-1">remove-teammate</code></li>
            <li><code className="rounded bg-muted px-1">fetch-ai-usage</code>, <code className="rounded bg-muted px-1">ask-support-overview</code></li>
          </ul>
        </>
      ),
    },
    {
      id: 'security',
      get title() { return uiText('Security model'); },
      body: (
        <ul className="list-disc pl-5 space-y-1">
          <li><strong>{uiText("Widget endpoints")}</strong> {uiText(" are public (auth: none). Authorization is by ")}<code className="rounded bg-muted px-1">visitor_token</code>
            {uiText("scoping in the function (server filters every query by the token). CORS is open because the threat model is per-visitor isolation, not origin gating.")}</li>
          <li><strong>{uiText("Admin endpoints")}</strong> {uiText(" require a valid end-user JWT and are RLS-gated to membership-bearing users.")}</li>
          <li><strong>{uiText("Sensitive tables")}</strong> (<code className="rounded bg-muted px-1">autonomy_settings</code>, <code className="rounded bg-muted px-1">escalation_targets</code>, <code className="rounded bg-muted px-1">app_allowlist</code>{uiText(", etc.) restrict writes to owner/admin via RLS.")}</li>
          <li><strong>{uiText("Internal worker")}</strong> {uiText(" calls (")}<code className="rounded bg-muted px-1">widget-ingest → auto-reply-worker</code>{uiText(") are gated by a shared bearer token in env, not by origin.")}</li>
          <li><strong>{uiText("AI key")}</strong> {uiText(" is scoped to ")}<code className="rounded bg-muted px-1">ai:gateway</code> {uiText(" only and lives in the worker's encrypted env vars.")}</li>
        </ul>
      ),
    },
    {
      id: 'troubleshoot',
      get title() { return uiText('Troubleshooting'); },
      body: (
        <>
          <p><strong>{uiText("Widget launcher doesn't appear.")}</strong> {uiText(" Open the browser console and look for ")}<code className="rounded bg-muted px-1">[ButterSupport] no app id</code> {uiText(" — the ")}<code className="rounded bg-muted px-1">data-app-id</code> {uiText(" attribute is missing or the script tag was injected without it. Verify the snippet on Settings → Widget matches what's on your page.")}</p>
          <p><strong>{uiText("Visitor's conversation resets every reload.")}</strong> {uiText(" The widget needs ")}<code className="rounded bg-muted px-1">localStorage</code>{uiText(". Private browsing, locked-down iframes, and some browser extensions block it — the widget falls back to in-memory tokens (one-session-only) when that happens.")}</p>
          <p><strong>{uiText("AI doesn't reply.")}</strong> {uiText(" Check ")}<code className="rounded bg-muted px-1">activities</code> {uiText(" for the ticket — look for ")}<code className="rounded bg-muted px-1">auto_reply.failed</code>{uiText(". The ")}<code className="rounded bg-muted px-1">payload.error</code> {uiText(" field tells you whether it was an AI gateway error, an RAG miss, or a network glitch.")}</p>
          <p><strong>{uiText("AI keeps saying \"I don't have docs.\"")}</strong> {uiText(" The ")}<code className="rounded bg-muted px-1">support-docs</code> {uiText(" collection is empty or doesn't cover the topic. Add sources in Settings → Docs and wait for ingestion to complete.")}</p>
          <p><strong>{uiText("Customer message doesn't show in the panel.")}</strong> {uiText(" Verified-fixed in widget v2 — the poll merge used to strip local optimistic messages. If you see this again, the deployed ")}<code className="rounded bg-muted px-1">widget.js</code> {uiText(" may be stale; re-deploy.")}</p>
        </>
      ),
    },
    {
      id: 'faq',
      get title() { return uiText('FAQ'); },
      body: (
        <>
          <p><strong>{uiText("Q. Does the widget work for visitors who aren't logged in?")}</strong><br />{uiText("Yes — that's the default. A visitor token is minted on first load, stored in localStorage, and used to scope the conversation. No host-side auth required.")}</p>
          <p><strong>{uiText("Q. Can two devices share a conversation?")}</strong><br />{uiText("Not today. The visitor token is per-browser. Cross-device continuity needs signed identity (future work).")}</p>
          <p><strong>{uiText("Q. What happens if the customer reopens a resolved ticket?")}</strong><br />{uiText("A follow-up message flips the ticket from ")}<code className="rounded bg-muted px-1">resolved</code> {uiText(" back to ")}<code className="rounded bg-muted px-1">open</code> {uiText(" automatically.")}</p>
          <p><strong>{uiText("Q. How do I switch to manual approval before the AI replies to anyone?")}</strong><br />{uiText("Settings → Autonomy → set default to ")}<code className="rounded bg-muted px-1">draft_for_approval</code>{uiText(". The agent will keep drafting; nothing reaches customers without your click.")}</p>
          <p><strong>{uiText("Q. Can I host the widget on multiple domains?")}</strong><br />{uiText("Yes. CORS on the widget endpoints is open. Same script, same app id, any host.")}</p>
        </>
      ),
    },
  ], [base, installSnippet, identifySnippet, uiLocale]);

  const filtered = useMemo(() => {
    if (!query.trim()) return sections;
    const q = query.toLowerCase();
    return sections.filter((s) => s.title.toLowerCase().includes(q));
  }, [query, sections]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-6 lg:gap-12 px-4 sm:px-8 py-8 max-w-6xl mx-auto">
        <aside className="lg:sticky lg:top-8 self-start">
          <div className="section-label mb-3">{uiText("Operator's guide")}</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={uiText("Filter sections…")}
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
            <p className="eyebrow mb-3">{uiText("Docs")}</p>
            <h1 className="page-title">
              {uiText("Operator's ")}<em>{uiText("guide")}</em>
            </h1>
            <p className="mt-3 font-editorial italic text-[15px] text-muted-foreground max-w-xl">
              {uiText("Install, configure, and operate the Butter Support agent. Every recipe needs a good cookbook.")}</p>
          </header>

          <div className="space-y-6">
            {filtered.map((s) => (
              <Card key={s.id} id={s.id} className="scroll-mt-8">
                <CardHeader>
                  <CardTitle>
                    <a href={`#${s.id}`} className="hover:text-butter transition-colors">{s.title}</a>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm leading-6 break-words [overflow-wrap:anywhere] text-foreground/85 [&_p]:my-0 [&_a]:text-butter [&_a]:underline [&_a]:decoration-dotted [&_a]:underline-offset-2">
                  {s.body}
                </CardContent>
              </Card>
            ))}
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground">{uiText("No sections match “")}{query}{uiText("”.")}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ code, desc }: { code: string; desc: string }) {
  useUiLocale();
  return (
    <tr>
      <td className="py-2 pr-4 align-top"><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded text-xs">{code}</code></td>
      <td className="py-2 align-top text-muted-foreground">{uiText(desc)}</td>
    </tr>
  );
}

function Row3({ a, b, c }: { a: string; b: string; c: string }) {
  useUiLocale();
  return (
    <tr>
      <td className="py-2 pr-4 align-top"><code className="font-mono text-caramel bg-butter-50 px-1.5 py-0.5 rounded text-xs">{a}</code></td>
      <td className="py-2 pr-4 align-top text-muted-foreground">{b}</td>
      <td className="py-2 align-top text-muted-foreground">{c}</td>
    </tr>
  );
}
