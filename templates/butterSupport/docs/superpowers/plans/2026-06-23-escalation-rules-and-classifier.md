# Escalation Rules + Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the support agent force-escalate based on (a) topic (billing/cancellation/etc.) and (b) signals (explicit human-request, message bursts, N-turns without resolution, anger keywords) — not just RAG-score misses.

**Architecture:** Two orthogonal escalation routes added inside `SupportTicketDO.runAgentLoop`. **Route A** is a deterministic precheck (zero-token regex + COUNT() queries over `support_messages`) that runs FIRST and force-escalates on hard signals. **Route B** is a one-call Haiku classifier that sets `support_tickets.issue_type` AND looks up `autonomy_settings.mode` for that issue_type; if mode is `force_escalate`, the DO skips drafting and escalates with the topic in the reason. Both routes use the existing `toolPropose_escalation` (which already posts directly to `execute-escalation` via HMAC). The Autonomy settings UI gains a new `force_escalate` mode and a one-click "Apply recommended defaults" seed button.

**Tech Stack:** Cloudflare Durable Object (plain JS, `cloudflare:workers` runtime, no npm imports), React 18 + TanStack Query frontend (frontend-redesign), Butterbase auto-API + AI gateway (`/chat/completions` with `anthropic/claude-haiku-4.5`).

## Global Constraints

- App id: `app_0ycj4ad7odud`. DO name: `support-ticket-do`. Function URL pattern: `${BUTTERBASE_API_URL}/v1/${BUTTERBASE_APP_ID}/fn/execute-escalation`.
- Source-of-truth file for the DO source lives ONLY in `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`. Always edit that file first, sanity-check with `node --check`, then deploy via `mcp__butterbase__manage_durable_objects` `action: "deploy"` with `access_mode: "public"`. NEVER round-trip through `mcp get` → `mcp deploy` (a prior session corrupted backslashes that way).
- All frontend changes go in `frontend-redesign/src/console/routes/settings/Autonomy.tsx`. **Do NOT touch `frontend/`.**
- No git commits this session (no git repo at project root). Use the build-log at `docs/butterbase/04-build-log.md` as the audit trail.
- The seven canonical autonomy modes for THIS plan are: `draft_for_approval`, `auto_send`, `auto_resolve`, `force_escalate`. The first three exist; the fourth is new.
- `autonomy_settings.mode` has no CHECK constraint in the deployed schema (verified via `manage_schema get`), so storing `'force_escalate'` is a plain insert — no migration needed.
- `support_tickets.issue_type` is nullable; today every ticket has `issue_type=null`. After Task 3 the classifier writes it on every new agent turn.
- Recommended default overrides to seed (Task 1):
  - **force_escalate**: `billing`, `cancellation`, `refund_request`, `account_deletion`, `data_privacy`, `security_incident`, `legal`, `complaint`, `outage`
  - **auto_resolve**: `password_reset`, `how_to`, `pricing_inquiry`
- The classifier vocabulary the DO sends to Haiku is exactly the union of the seeded issue_types above PLUS `other`. Adding new issue_types later requires updating both the DO prompt and the seed list — keep them in lockstep.
- Precheck thresholds (Task 2):
  - **Message burst**: ≥ 4 `role='customer'` messages within the last 10 minutes AND zero `role='founder'` messages ever on the ticket.
  - **N-turns unresolved**: ≥ 3 `role='customer'` messages AND ≥ 2 `role='agent_draft'` messages AND ticket.status NOT IN (`'resolved'`,`'escalated'`,`'closed'`,`'sent'`).
  - **Human-request keywords** (case-insensitive regex on the combined body of the last 3 `role='customer'` messages): `/\b(real|human|live)\s+(person|agent|support|rep|representative)\b|\bspeak\s+(to|with)\s+(a\s+)?(person|human|manager|supervisor|agent)\b|\bnot\s+(a\s+)?bot\b|\bstop\s+(the\s+)?bot\b|\bpass\s+me\s+(to|on)\b/i`
  - **Anger keywords** (case-insensitive): `/\b(ridiculous|unacceptable|disgusted|furious|outrageous|sue\s+you|lawyer|lawsuit|refund\s+me\s+now)\b/i` OR ≥ 4 consecutive ALL-CAPS words of length ≥ 3 in any single recent customer message.
- The DO must call `toolPropose_escalation({reason, urgency})` for force-escalations. Set `urgency='urgent'` for human-request + anger, `urgency='high'` for burst + N-turns + topic-based, `urgency='normal'` otherwise.

---

## File Structure

| File | Responsibility |
|---|---|
| Platform DO `support-ticket-do` (edit `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`, deploy via MCP) | New `precheckForceEscalation()` (Task 2) + new `classifyIssueType()` (Task 3) + new `getAutonomyMode()` (Task 3) + new early-exit dispatch at top of `runAgentLoop` (Task 3). |
| `frontend-redesign/src/console/routes/settings/Autonomy.tsx` | Add `force_escalate` mode option + copy; add "Apply recommended defaults" button (Task 1). |
| `autonomy_settings` rows (data via curl PATCH/INSERT) | Seed 12 default override rows (Task 1). |
| `docs/butterbase/04-build-log.md` | Append a line per task; no commits. |

---

## Task 1: UI mode + seeded default overrides

**Files:**
- Modify: `frontend-redesign/src/console/routes/settings/Autonomy.tsx` (whole file)
- Data: insert 12 rows into `autonomy_settings`

**Interfaces:**
- Consumes: existing `bb.from('autonomy_settings').insert/update/delete`, existing `Mode`/`MODES`/`MODE_COPY` constants.
- Produces: a `Mode` type that now includes `'force_escalate'`, and a button `applyRecommendedDefaults()` that bulk-upserts 12 rows. Task 3's autonomy lookup will read these rows by `issue_type`.

- [ ] **Step 1: Read the current file to confirm starting point**

```bash
sed -n '1,60p' /Users/kenneth/Documents/butterSupport/frontend-redesign/src/console/routes/settings/Autonomy.tsx
```

Confirm line 11 is `type Mode = 'draft_for_approval' | 'auto_send' | 'auto_resolve';` and line 14 is `const MODES: Mode[] = ['draft_for_approval', 'auto_send', 'auto_resolve'];`.

- [ ] **Step 2: Extend the Mode union and MODES array**

Edit `frontend-redesign/src/console/routes/settings/Autonomy.tsx`. Replace lines 11 and 14:

```tsx
type Mode = 'draft_for_approval' | 'auto_send' | 'auto_resolve' | 'force_escalate';
```

```tsx
const MODES: Mode[] = ['draft_for_approval', 'auto_send', 'auto_resolve', 'force_escalate'];
```

- [ ] **Step 3: Add MODE_COPY entry for `force_escalate`**

In `MODE_COPY` (around lines 16–32), add a fourth entry AFTER `auto_resolve`:

```tsx
  force_escalate: {
    label: 'Always escalate',
    desc: 'Agent never drafts a reply. Every ticket of this type goes straight to a human via your default escalation target.',
    tone: 'caution',
  },
```

(Reuse `tone: 'caution'` — amber badge — since the action is bold but safe; `tone: 'danger'` is reserved for auto-resolve.)

- [ ] **Step 4: Add the `applyRecommendedDefaults` function**

After the `remove` function (around line 100), insert:

```tsx
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
    if (!confirm(`Insert ${RECOMMENDED_DEFAULTS.length} recommended autonomy overrides? Existing rows with the same issue_type will be left alone.`)) return;
    setBusy(true);
    try {
      const existing = new Set(rows.map((r) => r.issue_type));
      let inserted = 0;
      for (const def of RECOMMENDED_DEFAULTS) {
        if (existing.has(def.issue_type)) continue;
        await bb.from('autonomy_settings').insert(def);
        inserted++;
      }
      qc.invalidateQueries({ queryKey: ['autonomy_settings'] });
      alert(`Inserted ${inserted} of ${RECOMMENDED_DEFAULTS.length} recommended overrides. (${RECOMMENDED_DEFAULTS.length - inserted} already existed.)`);
    } catch (e: any) {
      alert(e?.message || 'Apply failed');
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 5: Wire the button into the JSX**

In the "Per-issue overrides" `<Card>`, find the `<div className="flex gap-2 flex-wrap">` that holds the "Add override" input/select/button (around lines 129–140). Above that div (still inside the same `<CardContent>`, before the input row), insert:

```tsx
          {rows.length <= 1 && (
            <div className="rounded-2xl border border-dashed border-rule-soft bg-paper-soft/40 p-4">
              <div className="mb-2 text-sm font-medium text-foreground">Get started in one click</div>
              <p className="mb-3 text-xs text-muted-foreground">
                Seed 12 common overrides: billing / cancellation / refund / legal / security &amp; 6 more force-escalate; password_reset / how_to / pricing_inquiry auto-resolve.
              </p>
              <Button size="sm" variant="outline" onClick={applyRecommendedDefaults} disabled={busy}>
                {busy ? 'Applying…' : 'Apply recommended defaults'}
              </Button>
            </div>
          )}
```

The `rows.length <= 1` guard hides the prompt once any overrides exist (the founder has clearly already started customizing).

- [ ] **Step 6: Typecheck**

```bash
cd /Users/kenneth/Documents/butterSupport/frontend-redesign && npx tsc --noEmit
```

Expected: empty output (clean).

- [ ] **Step 7: Verify rendering in the browser**

```bash
cd /Users/kenneth/Documents/butterSupport/frontend-redesign && npm run dev
```

Navigate to `http://localhost:5173/settings/autonomy` (or whatever port Vite reports). Verify: (a) the "Always escalate" option appears in BOTH the default-row select AND the "Add override" select; (b) the "Apply recommended defaults" card is visible (since only the `default` row exists); (c) clicking it (after confirming) inserts 12 rows and they appear immediately in the list; (d) after the click, the seed card disappears.

- [ ] **Step 8: Verify rows in the database**

`mcp__butterbase__select_rows` with `{ app_id: "app_0ycj4ad7odud", table: "autonomy_settings", limit: 20, order: "issue_type.asc" }`.

Expected: 13 rows total — `default` + the 12 seeded types. Each force_escalate row has `mode='force_escalate'`. Each auto_resolve row has `mode='auto_resolve'`.

- [ ] **Step 9: Append build-log entry**

```bash
cat >> /Users/kenneth/Documents/butterSupport/docs/butterbase/04-build-log.md <<'EOF'
| <ISO ts> | frontend | autonomy UI + recommended defaults | ok — force_escalate mode added (label "Always escalate"); applyRecommendedDefaults() seeds 12 overrides (9 force_escalate + 3 auto_resolve). UI gates the seed CTA behind rows.length<=1. tsc clean. |
EOF
```

(Replace `<ISO ts>` with `$(date -u +%FT%TZ)`.)

---

## Task 2: DO deterministic precheck (signals, no LLM)

**Files:**
- Modify: `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`
- Deploy via: `mcp__butterbase__manage_durable_objects` action=`deploy`

**Interfaces:**
- Consumes: `this.apiGet(\`support_messages?ticket_id=eq.${this.ticketId}&order=created_at.desc&limit=20&select=role,body,created_at\`)`, existing `this.toolPropose_escalation({reason, urgency})`.
- Produces: New instance method `precheckForceEscalation(): Promise<{ escalate: true, reason: string, urgency: 'urgent'|'high' } | { escalate: false }>`. Pure function-style — only reads DB + returns a decision, does not call the tool itself. Task 3 wires it into `runAgentLoop`.

- [ ] **Step 1: Add module-level regex constants**

Edit `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`. After the `signOutboxBody` helper (just before `export class SupportTicketDO extends DurableObject`), add:

```js
const HUMAN_REQUEST_REGEX = /\b(real|human|live)\s+(person|agent|support|rep|representative)\b|\bspeak\s+(to|with)\s+(a\s+)?(person|human|manager|supervisor|agent)\b|\bnot\s+(a\s+)?bot\b|\bstop\s+(the\s+)?bot\b|\bpass\s+me\s+(to|on)\b/i;

const ANGER_REGEX = /\b(ridiculous|unacceptable|disgusted|furious|outrageous|sue\s+you|lawyer|lawsuit|refund\s+me\s+now)\b/i;

function hasAllCapsBurst(text) {
  if (!text) return false;
  let run = 0;
  for (const word of text.split(/\s+/)) {
    const clean = word.replace(/[^A-Za-z]/g, '');
    if (clean.length >= 3 && clean === clean.toUpperCase() && /[A-Z]/.test(clean)) {
      run++;
      if (run >= 4) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

const BURST_MAX_AGE_MS = 10 * 60 * 1000;
const BURST_MIN_MSGS = 4;
const NTURNS_MIN_CUSTOMER = 3;
const NTURNS_MIN_DRAFTS = 2;
const NTURNS_TERMINAL_STATUSES = new Set(['resolved', 'escalated', 'closed', 'sent']);
```

- [ ] **Step 2: Add the `precheckForceEscalation` method**

Inside the `SupportTicketDO` class, insert a new method AFTER `toolRequest_followup(args)` (the last method before the closing `}`). The full method:

```js
  async precheckForceEscalation() {
    let messages;
    try {
      messages = await this.apiGet(`support_messages?ticket_id=eq.${this.ticketId}&order=created_at.desc&limit=20&select=role,body,created_at`);
    } catch (err) {
      console.error('[SupportTicketDO] precheckForceEscalation read failed', err?.message);
      return { escalate: false };
    }
    if (!Array.isArray(messages) || messages.length === 0) return { escalate: false };

    const customerMsgs = messages.filter(m => m.role === 'customer');
    const draftMsgs = messages.filter(m => m.role === 'agent_draft');
    const founderMsgs = messages.filter(m => m.role === 'founder');
    const lastThreeCustomerBody = customerMsgs.slice(0, 3).map(m => m.body || '').join('\n');

    // 1. Explicit human-request — urgency: urgent
    if (HUMAN_REQUEST_REGEX.test(lastThreeCustomerBody)) {
      return { escalate: true, reason: 'Customer explicitly requested a human agent.', urgency: 'urgent' };
    }

    // 2. Anger — urgency: urgent
    if (ANGER_REGEX.test(lastThreeCustomerBody) || customerMsgs.slice(0, 3).some(m => hasAllCapsBurst(m.body))) {
      return { escalate: true, reason: 'Customer message detected as hostile (keyword or sustained ALL-CAPS).', urgency: 'urgent' };
    }

    // 3. Message burst — urgency: high
    if (founderMsgs.length === 0) {
      const cutoff = Date.now() - BURST_MAX_AGE_MS;
      const recentCustomerCount = customerMsgs.filter(m => {
        const ts = Date.parse(m.created_at);
        return Number.isFinite(ts) && ts >= cutoff;
      }).length;
      if (recentCustomerCount >= BURST_MIN_MSGS) {
        return { escalate: true, reason: `Customer sent ${recentCustomerCount} messages in ${BURST_MAX_AGE_MS / 60000} min with no founder reply.`, urgency: 'high' };
      }
    }

    // 4. N-turns unresolved — urgency: high
    let ticketStatus = null;
    try {
      const t = await this.apiGet(`support_tickets?id=eq.${this.ticketId}&select=status`);
      ticketStatus = t?.[0]?.status || null;
    } catch {}
    if (
      customerMsgs.length >= NTURNS_MIN_CUSTOMER &&
      draftMsgs.length >= NTURNS_MIN_DRAFTS &&
      !NTURNS_TERMINAL_STATUSES.has(ticketStatus)
    ) {
      return { escalate: true, reason: `${customerMsgs.length} customer turns + ${draftMsgs.length} agent drafts without resolution.`, urgency: 'high' };
    }

    return { escalate: false };
  }
```

- [ ] **Step 3: Syntax-check**

```bash
node --check /Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js && echo OK
```

Expected: `OK`.

- [ ] **Step 4: Add unit-style smoke probes (run locally with node)**

```bash
node --input-type=module -e "
const HUMAN = /\b(real|human|live)\s+(person|agent|support|rep|representative)\b|\bspeak\s+(to|with)\s+(a\s+)?(person|human|manager|supervisor|agent)\b|\bnot\s+(a\s+)?bot\b|\bstop\s+(the\s+)?bot\b|\bpass\s+me\s+(to|on)\b/i;
const ANGER = /\b(ridiculous|unacceptable|disgusted|furious|outrageous|sue\s+you|lawyer|lawsuit|refund\s+me\s+now)\b/i;
const cases = [
  ['Pass me to a human agent right now', HUMAN, true],
  ['I want to speak with a manager', HUMAN, true],
  ['I do not want to talk to a bot', HUMAN, true],
  ['how do I reset my password?', HUMAN, false],
  ['THIS IS RIDICULOUS', ANGER, true],
  ['this is unacceptable', ANGER, true],
  ['please help when you can', ANGER, false],
];
let bad = 0;
for (const [msg, re, want] of cases) {
  const got = re.test(msg);
  if (got !== want) { console.error('FAIL:', JSON.stringify(msg), 'got', got, 'want', want); bad++; }
}
console.log(bad === 0 ? 'ALL PASS' : bad + ' FAILED');
process.exit(bad === 0 ? 0 : 1);
"
```

Expected: `ALL PASS`.

- [ ] **Step 5: Deploy the DO**

Use a subagent dispatched at model `haiku` because this is a single MCP call with a file already on disk:

Dispatch with this prompt verbatim:
> Single MCP call. (1) Read `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js` using Read (no offset/limit). (2) Call `mcp__butterbase__manage_durable_objects` with `{app_id:"app_0ycj4ad7odud", action:"deploy", name:"support-ticket-do", code: <full file contents>, access_mode:"public"}`. (3) Return `last_deployed_at` and `status` from the response. Do NOT verify. Do NOT round-trip through `mcp get`. Just deploy.

- [ ] **Step 6: Verify the deploy from the controller side**

After the subagent returns, call `mcp__butterbase__manage_durable_objects` `action: "get"` yourself and confirm:
- `access_mode: "public"` (CRITICAL — a default of `"authenticated"` will break the widget WS upgrade)
- The string `precheckForceEscalation` is present in the returned `code`
- The string `HUMAN_REQUEST_REGEX` is present
- `replace(/^Bearer\s+/i, '')` appears at LEAST twice in the code (sanity check that backslash-escapes weren't doubled — search literal `\\s` in the JSON response should be EXACTLY one backslash before `s`, i.e. `\\\\s` in the raw response is wrong and means corruption)

- [ ] **Step 7: Append build-log entry**

```bash
cat >> /Users/kenneth/Documents/butterSupport/docs/butterbase/04-build-log.md <<EOF
| $(date -u +%FT%TZ) | durable | support-ticket-do redeploy — precheckForceEscalation added | ok — pure-detection method: human-request keywords (urgency=urgent), anger keywords + ALL-CAPS run (urgent), 4+ customer msgs <10min no-founder (high), 3+ customer + 2+ drafts unresolved (high). Returns {escalate, reason, urgency} — not yet wired into runAgentLoop (Task 3 does that). |
EOF
```

---

## Task 3: DO classifier + autonomy_settings lookup + runAgentLoop dispatch

**Files:**
- Modify: `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`
- Deploy via: `mcp__butterbase__manage_durable_objects` action=`deploy`

**Interfaces:**
- Consumes: Task 2's `this.precheckForceEscalation()`; the AI gateway at `${BUTTERBASE_API_URL}/v1/${BUTTERBASE_APP_ID}/chat/completions`; `autonomy_settings` rows seeded by Task 1; existing `this.toolPropose_escalation(args)`.
- Produces: New instance methods `classifyIssueType(): Promise<string | null>` (returns issue_type label from a closed vocabulary, writes it to `support_tickets.issue_type`) and `getAutonomyMode(issue_type: string | null): Promise<string>` (looks up `autonomy_settings`, falls back to `default` row, falls back to `'draft_for_approval'`). Modifies `runAgentLoop(mode, hint)` so that BEFORE the existing `buildConversation`+chat loop, it runs precheck → classify → autonomy lookup → conditional force-escalate.

- [ ] **Step 1: Add the classifier vocabulary constant**

Edit `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`. After the precheck constants from Task 2 (where `NTURNS_TERMINAL_STATUSES` is defined), add:

```js
const CLASSIFIER_VOCABULARY = [
  'billing', 'cancellation', 'refund_request', 'account_deletion',
  'data_privacy', 'security_incident', 'legal', 'complaint', 'outage',
  'password_reset', 'how_to', 'pricing_inquiry',
  'account_lockout', 'email_change', 'subscription_change',
  'bug_report', 'onboarding_help', 'feature_request',
  'other'
];

const CLASSIFIER_PROMPT = `You classify a support ticket into ONE of these issue_types: ${CLASSIFIER_VOCABULARY.join(', ')}. Pick the SINGLE best match. If genuinely unclear, pick "other". Respond ONLY with a JSON object like {"issue_type":"billing"}. No prose, no markdown.`;
```

- [ ] **Step 2: Add the `classifyIssueType` method**

Inside the `SupportTicketDO` class, AFTER `precheckForceEscalation`, insert:

```js
  async classifyIssueType() {
    let messages;
    try {
      messages = await this.apiGet(`support_messages?ticket_id=eq.${this.ticketId}&role=eq.customer&order=created_at.asc&limit=5&select=body`);
    } catch (err) {
      console.error('[SupportTicketDO] classifyIssueType read failed', err?.message);
      return null;
    }
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const sample = messages.map(m => m.body || '').join('\n---\n').slice(0, 2000);

    let resp;
    try {
      const r = await fetch(`${this.env.BUTTERBASE_API_URL}/v1/${this.env.BUTTERBASE_APP_ID}/chat/completions`, {
        method: 'POST', headers: this.apiHeaders(),
        body: JSON.stringify({
          model: 'anthropic/claude-haiku-4.5',
          max_tokens: 60,
          messages: [
            { role: 'system', content: CLASSIFIER_PROMPT },
            { role: 'user', content: sample }
          ]
        })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error('[SupportTicketDO] classifyIssueType LLM error', r.status, txt.slice(0, 200));
        return null;
      }
      resp = await r.json();
    } catch (err) {
      console.error('[SupportTicketDO] classifyIssueType LLM threw', err?.message);
      return null;
    }

    const raw = resp?.choices?.[0]?.message?.content || '';
    let parsed = null;
    try {
      const m = raw.match(/\{[^}]*"issue_type"[^}]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch {}
    let label = (parsed && typeof parsed.issue_type === 'string') ? parsed.issue_type.toLowerCase().trim() : null;
    if (!label || !CLASSIFIER_VOCABULARY.includes(label)) {
      console.warn('[SupportTicketDO] classifyIssueType: rejected label', label, 'raw', raw.slice(0, 120));
      return null;
    }

    this.apiPatch('support_tickets', this.ticketId, { issue_type: label }).catch((e) => {
      console.error('[SupportTicketDO] classifyIssueType write failed', e?.message);
    });
    this.emit({ type: 'classified', issue_type: label });
    return label;
  }

  async getAutonomyMode(issueType) {
    try {
      if (issueType) {
        const r = await this.apiGet(`autonomy_settings?issue_type=eq.${encodeURIComponent(issueType)}&select=mode&limit=1`);
        if (r?.[0]?.mode) return r[0].mode;
      }
      const d = await this.apiGet(`autonomy_settings?issue_type=eq.default&select=mode&limit=1`);
      return d?.[0]?.mode || 'draft_for_approval';
    } catch (err) {
      console.error('[SupportTicketDO] getAutonomyMode failed', err?.message);
      return 'draft_for_approval';
    }
  }
```

- [ ] **Step 3: Wire precheck + classifier + autonomy into `runAgentLoop`**

Find the `runAgentLoop(mode, hint)` method. After the existing `if (mode === 'escalate') { … return; }` block but BEFORE `const messages = this.buildConversation(tctx, hint);`, insert this routing block:

```js
    // === Force-escalation routing (precheck → classify → autonomy lookup) ===
    // Founder-forced escalations and explicit escalate-mode runs SKIP this routing.
    if (mode !== 'escalate') {
      try {
        const pre = await this.precheckForceEscalation();
        if (pre.escalate) {
          await this.toolPropose_escalation({ reason: `precheck: ${pre.reason}`, urgency: pre.urgency });
          await this.setStatus('done');
          return;
        }
      } catch (err) {
        console.error('[SupportTicketDO] precheck threw, continuing', err?.message);
      }

      let issueType = null;
      try {
        issueType = await this.classifyIssueType();
      } catch (err) {
        console.error('[SupportTicketDO] classify threw, continuing without issue_type', err?.message);
      }

      let autonomyMode = 'draft_for_approval';
      try {
        autonomyMode = await this.getAutonomyMode(issueType);
      } catch {}

      if (autonomyMode === 'force_escalate') {
        await this.toolPropose_escalation({
          reason: `autonomy_settings: issue_type=${issueType || 'unknown'} → force_escalate`,
          urgency: 'high'
        });
        await this.setStatus('done');
        return;
      }
    }
    // === End force-escalation routing ===
```

- [ ] **Step 4: Syntax-check**

```bash
node --check /Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js && echo OK
```

Expected: `OK`.

- [ ] **Step 5: Deploy the DO**

Same subagent dispatch as Task 2 Step 5 — single MCP call, file already on disk, model `haiku`:

> Single MCP call. (1) Read `/Users/kenneth/Documents/butterSupport/.superpowers/sdd/task-1-fixed-do.js`. (2) Call `mcp__butterbase__manage_durable_objects` with `{app_id:"app_0ycj4ad7odud", action:"deploy", name:"support-ticket-do", code: <full file contents>, access_mode:"public"}`. (3) Return `last_deployed_at`. Do NOT verify. Just deploy.

- [ ] **Step 6: Verify the deploy from the controller**

Call `mcp__butterbase__manage_durable_objects` `action: "get"` yourself and confirm the returned `code` contains all three new sentinels:
- `classifyIssueType`
- `getAutonomyMode`
- `=== Force-escalation routing`

Also re-confirm `access_mode: "public"` and `replace(/^Bearer\\s+/i` (one backslash before `s` in the JSON-encoded response).

- [ ] **Step 7: Append build-log entry**

```bash
cat >> /Users/kenneth/Documents/butterSupport/docs/butterbase/04-build-log.md <<EOF
| $(date -u +%FT%TZ) | durable | support-ticket-do redeploy — classifier + autonomy dispatch | ok — runAgentLoop now: (1) precheckForceEscalation → exit if hit; (2) classifyIssueType via Haiku → write support_tickets.issue_type; (3) getAutonomyMode(issue_type) → if force_escalate, exit. Closed vocabulary: 18 issue_types + other. Defaults to draft_for_approval on classifier failures. |
EOF
```

---

## Task 4: End-to-end verification

**Files:**
- No code. Pure verification.

**Interfaces:** none.

- [ ] **Step 1: Probe each precheck signal in isolation**

Reuse `/tmp/probe_runner.py` (created in earlier research) but extend the scenarios. Create `/tmp/probe-task4.py`:

```python
#!/usr/bin/env python3
import json, os, urllib.request, uuid, time
API = os.environ["BUTTERBASE_API_URL"]; APP = os.environ["BUTTERBASE_APP_ID"]; KEY = os.environ["BUTTERBASE_API_KEY"]

def post(path, body):
  req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(),
    headers={"Authorization":f"Bearer {KEY}","Content-Type":"application/json","Prefer":"return=representation"})
  with urllib.request.urlopen(req) as r: return json.load(r)

def make_ticket(subject, email):
  t = post(f"/v1/{APP}/support_tickets", {"channel":"widget","customer_email":email,"subject":subject,"status":"open"})
  return t["id"] if isinstance(t, dict) else t[0]["id"]

def add_msg(ticket_id, role, body):
  return post(f"/v1/{APP}/support_messages", {"ticket_id":ticket_id,"role":role,"body":body})

cases = []

# 1. human-request
t1 = make_ticket("probe human-request", "probe1@example.test")
add_msg(t1, "customer", "Please pass me to a real human agent. I do not want a bot.")
cases.append(("human-request", t1))

# 2. anger keyword
t2 = make_ticket("probe anger", "probe2@example.test")
add_msg(t2, "customer", "THIS IS RIDICULOUS. I want my money back.")
cases.append(("anger", t2))

# 3. burst (4 msgs)
t3 = make_ticket("probe burst", "probe3@example.test")
for line in ["hi", "hello?", "anyone there", "please respond"]:
  add_msg(t3, "customer", line)
cases.append(("burst", t3))

# 4. N-turns unresolved (3 customer + 2 drafts)
t4 = make_ticket("probe nturns", "probe4@example.test")
add_msg(t4, "customer", "my API times out")
add_msg(t4, "agent_draft", "Have you tried retrying?")
add_msg(t4, "customer", "yes, still times out")
add_msg(t4, "agent_draft", "Could you share the URL?")
add_msg(t4, "customer", "I already gave it to you twice")
cases.append(("nturns", t4))

# 5. topic-based: billing
t5 = make_ticket("probe billing", "probe5@example.test")
add_msg(t5, "customer", "You charged my card twice this month. I need a refund for the duplicate $49 charge.")
cases.append(("billing-topic", t5))

# 6. control: docs-resolvable (should NOT escalate)
t6 = make_ticket("probe control", "probe6@example.test")
add_msg(t6, "customer", "Hi, how do I invite a teammate to my workspace?")
cases.append(("control-docs", t6))

print(json.dumps(cases))
```

Run:
```bash
set -a; . /Users/kenneth/Documents/butterSupport/.env; set +a
python3 /tmp/probe-task4.py > /tmp/probe-task4.json
cat /tmp/probe-task4.json
```

Expected: a JSON array of 6 `[name, ticket_uuid]` pairs.

- [ ] **Step 2: Drive each ticket through the DO**

The DO requires a user JWT. Two options:
- (a) Open the console in a browser, click each probe ticket in the inbox, force the agent to run (the inbox auto-starts `runAgentLoopSafe('diagnose')` when a ticket is opened with new customer messages — confirm by tailing the realtime stream).
- (b) (Preferred for unattended runs) Drive the DO from a service-key-authenticated curl IF the WS upgrade accepts service keys. Try this first:

```bash
. /Users/kenneth/Documents/butterSupport/.env
TICKET=$(jq -r '.[0][1]' /tmp/probe-task4.json)
curl -sS -w "\nHTTP %{http_code}\n" -X POST "https://butter-support.butterbase.dev/_do/support-ticket-do/${TICKET}" \
  -H "Authorization: Bearer ${BUTTERBASE_API_KEY}" \
  -H "Content-Type: application/json" -d '{"cmd":"startDiagnosis"}'
```

If you get 403 (service keys aren't team members), fall back to (a): browser. The plan author confirmed this in the prior session.

- [ ] **Step 3: Verify each case's outcome**

Wait ~10s after each trigger. For each ticket, fetch the ticket + the latest escalation:

```bash
. /Users/kenneth/Documents/butterSupport/.env
for pair in $(jq -c '.[]' /tmp/probe-task4.json); do
  name=$(echo "$pair" | jq -r '.[0]')
  tid=$(echo "$pair" | jq -r '.[1]')
  echo "=== $name ($tid) ==="
  curl -sS "${BUTTERBASE_API_URL}/v1/${BUTTERBASE_APP_ID}/support_tickets?id=eq.${tid}&select=status,issue_type" -H "Authorization: Bearer ${BUTTERBASE_API_KEY}"
  echo
  curl -sS "${BUTTERBASE_API_URL}/v1/${BUTTERBASE_APP_ID}/escalations?ticket_id=eq.${tid}&select=reason,status,sent_at&order=created_at.desc&limit=1" -H "Authorization: Bearer ${BUTTERBASE_API_KEY}"
  echo
done
```

Expected outcomes:
- `human-request` → ticket.status=`escalated`, escalations.reason contains `precheck:` and `human`, status=`sent`
- `anger` → ticket.status=`escalated`, escalations.reason contains `precheck:` and `hostile`, status=`sent`
- `burst` → ticket.status=`escalated`, escalations.reason contains `precheck:` and `messages in 10 min`, status=`sent`
- `nturns` → ticket.status=`escalated`, escalations.reason contains `customer turns + 2 agent drafts`, status=`sent`
- `billing-topic` → ticket.issue_type=`billing`, ticket.status=`escalated`, escalations.reason contains `autonomy_settings: issue_type=billing → force_escalate`, status=`sent`
- `control-docs` → ticket.issue_type=`how_to` (or similar), ticket.status NOT `escalated`. The agent drafts a reply through the normal path.

- [ ] **Step 4: Confirm 5 real emails arrived at kcflexigbo@gmail.com**

Inbox check. Each subject prefixed `Support escalation:`. The `control-docs` case must NOT have sent an email.

- [ ] **Step 5: Clean up probe tickets**

```bash
. /Users/kenneth/Documents/butterSupport/.env
for pair in $(jq -c '.[]' /tmp/probe-task4.json); do
  tid=$(echo "$pair" | jq -r '.[1]')
  curl -sS -o /dev/null -w "delete %{http_code}\n" -X DELETE "${BUTTERBASE_API_URL}/v1/${BUTTERBASE_APP_ID}/support_tickets/${tid}" -H "Authorization: Bearer ${BUTTERBASE_API_KEY}"
done
```

- [ ] **Step 6: Append final build-log entry**

```bash
cat >> /Users/kenneth/Documents/butterSupport/docs/butterbase/04-build-log.md <<EOF
| $(date -u +%FT%TZ) | verify | E2E escalation rules — 6 probes (5 escalate, 1 control) | ok — human-request/anger/burst/nturns each fire precheck force_escalate; billing fires autonomy force_escalate with issue_type=billing; control (how_to) drafts normally. 5 emails delivered. |
EOF
```

---

## Self-Review Notes

**Spec coverage:** Each of the user's requested triggers is mapped to a step:
- Topic rules (billing → escalate, password_reset → handle) → Task 1 seeds + Task 3 autonomy lookup.
- 5-rapid-messages burst → Task 2 burst rule (4+ in 10 min).
- Pass me to an agent → Task 2 HUMAN_REQUEST_REGEX.
- Anger → Task 2 ANGER_REGEX + hasAllCapsBurst.
- "We have not been helpful so far" (N-turns) → Task 2 N-turns rule.

**Order rationale:** Task 1 is UI+data only and immediately visible. Task 2 deploys the precheck without wiring it (the DO does not yet call it), so deploying alone is safe — no behavior change. Task 3 flips the switch by adding the dispatch in `runAgentLoop`. This split means Task 2's deploy can be reverted without losing other work if a regex misfires.

**Placeholder scan:** every `<ISO ts>` placeholder is in a literal `cat >> ... <<EOF` block where `$(date -u +%FT%TZ)` is the production substitute — those steps tell the implementer to run that exact command, not leave a placeholder in the file. No other TBDs.

**Type consistency:** `Mode` (Task 1) gains `'force_escalate'`. `precheckForceEscalation()` returns `{escalate: boolean, reason?: string, urgency?: 'urgent'|'high'}` consistently between Task 2 definition and Task 3 consumer. `classifyIssueType()` returns `string|null` consistently. `getAutonomyMode()` returns `string` (always a mode string, never null), guaranteed by the `'draft_for_approval'` fallback.

**Out of scope (deliberate):**
- Substrate VIP-tier lookup. Adds complexity (substrate read in DO hot path) for marginal value. Defer to a future task.
- Cancellation/outage keyword precheck. The classifier should pick these up via Task 3, and they're already in the seeded `force_escalate` rows.
- Per-rule UI toggles (e.g. "disable burst detection"). The thresholds are constants; tune in code if needed.
- Multi-language tone detection. The English regexes will miss non-English tickets; flag if you start getting them.
