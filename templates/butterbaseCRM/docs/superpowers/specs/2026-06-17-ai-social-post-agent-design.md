# AI Social Post Agent — Design Spec

**Date:** 2026-06-17
**Status:** Implemented & deployed 2026-06-17
**Approach:** A — extend the existing `agent-chat` copilot with a `draft_social_post` capability.

## Goal

Let the user tell the in-app copilot what they want to post ("write a post about our win
with Acme", "summarize this week's pipeline as a LinkedIn update"). The agent uses its
existing access to the user's substrate + CRM data to gather real context, then writes
platform-tailored drafts for the user's connected channels. The user reviews and edits in
the existing composer before anything is published. **Nothing auto-posts.**

## Why this approach

`agent-chat` is already a threaded, streaming, tool-calling copilot with read access to the
whole workspace/substrate (`search_workspace`, `get_company`, `get_pipeline_summary`,
`get_person`, `get_deal`, `list_meetings`, `list_recent_activity`, `search_substrate_memory`,
`list_integrations`) and a UI-card pattern for surfacing actions (`ask_user`,
`confirm_action`, `suggest_next_step`, proposals). Adding post-drafting is therefore **one
new tool + one new UI card + a small composer prefill**, reusing the entire compose/publish
pipeline (`create-social-post` / `publish-social-post`, the flair dropdown, channel limits)
shipped earlier today.

## Data flow

```
user: "write a post about our win with Acme"
  → agent calls existing read tools (search_workspace, get_company, get_pipeline_summary,
    search_substrate_memory, …) to gather grounded context
  → agent calls draft_social_post({ channels, body, twitter?, linkedin?, reddit? })
  → handler intersects channels with connected providers, emits
    sseEvent('ui_event', { kind: 'draft_social_post', payload }) and persists a
    system_event agent_messages row
  → MessageList renders <SocialPostDraftCard payload/>
  → "Review & publish" → <SocialPostComposer initialContent={…}/> (create mode, prefilled)
  → user confirms subreddit/flair/edits → existing create-social-post / publish path
```

The copilot LLM itself writes the copy (it is already an LLM with tools); `draft_social_post`
does **not** make a second model call. It is the structured hand-off from "agent wrote text"
to "user reviews a card."

## Backend — `draft_social_post` tool (in `backend/functions/agent-chat/handler.ts`)

Registered alongside the other tools (copilot mode).

**input_schema**
```
{
  channels:  string[]                                  // subset of twitter | linkedin | reddit
  body:      string                                    // shared/default body
  twitter?:  { body: string }                          // platform override (≤ 280 enforced in composer)
  linkedin?: { body: string }
  reddit?:   { title: string, subreddit?: string, body?: string }
  rationale?: string                                   // why these drafts, shown on the card
}
```

**handler behavior**
1. Read connected providers for the workspace
   (`SELECT toolkit_slug FROM workspace_integrations WHERE workspace_id = $1`).
2. Intersect `channels` with connected providers. If the agent omits `channels`, default to
   all connected. If none of the requested channels are connected, return an `ok:false`
   outcome (`error: 'no connected channels for the requested set'`) so the agent can recover.
3. Build a payload `{ channels, body, twitter, linkedin, reddit, rationale }`.
4. Emit `sseEvent('ui_event', { kind: 'draft_social_post', payload })` and persist
   `INSERT INTO agent_messages (… role='system_event', ui_event)` — identical pattern to
   `ask_user` / `suggest_next_step`.
5. Return `{ ok: true, result: { rendered: true, channels }, summary: 'Drafted social posts' }`.

**system-prompt addition** (copilot mode only): instruct the agent that it can draft social
posts — gather real context with read tools first; write distinct copy per connected
platform; respect Twitter's 280-char limit and keep LinkedIn substantive; for Reddit propose
a subreddit + title but mark them as *verify before posting*; then call `draft_social_post`.

No new DB tables. No new env vars/secrets (agent already calls the AI gateway). Reuses the
existing per-user daily token budget and thread lock.

## Frontend

- **`SocialPostComposer`** — add an optional `initialContent?: { body?, channels?,
  channel_overrides? }` prop. Create-mode prefill: when `post` is absent but `initialContent`
  is present, initialize the form fields from it and stay in **create** mode (still uses
  `createSocialPost` / `save_as_draft`). `post` (edit existing) takes precedence when both
  are given. Only the init `useEffect` changes.
- **`SocialPostDraftCard`** (new, under `components/agent/`) — renders the per-platform
  drafts from the payload (icons + previews + rationale), with **"Review & publish"** and
  **"Dismiss"**. It hosts its own `SocialPostComposer` instance (same self-contained pattern
  as `SocialPostDetailPanel`), opened with `initialContent` derived from the payload
  (reddit title/subreddit/flair map into `channel_overrides.reddit`).
- **`MessageList`** — add a render branch for `ui_event.kind === 'draft_social_post'` →
  `<SocialPostDraftCard payload={…}/>`.
- **`lib/agent.ts` + stream/message hooks** — thread the new `ui_event` kind through the
  types (it is a generic `system_event`, so mostly type plumbing; no new transport).

## Safety / behavior

- **Human-in-loop:** drafts only; the user reviews in the composer before any publish.
- **Reddit:** subreddit renders as "AI-suggested — verify"; the flair dropdown
  (`get-subreddit-flairs`) is available in the composer, and `send-social-post` already
  flags flair/validation rejections as failures.
- **Channel limits** enforced by the composer (Twitter 280, etc.) and `create-social-post`.

## Testing / verification

- `tsc -b` must pass (frontend).
- The streaming agent can't be fully exercised through the MCP harness (auth gate + SSE), so
  final verification is a manual run in the deployed app: ask the copilot to draft a post →
  confirm the card renders → "Review & publish" opens the prefilled composer → publish →
  link appears on the post.

## Out of scope (YAGNI)

- A separate post-writing agent mode (Approach C).
- Auto-posting without review.
- Image/media generation.
- Scheduling from the card (user can still schedule in the composer).

## Notes

- Per the project's standing "no-git" setup, this spec is written but not committed.
