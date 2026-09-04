# butterbaseCRM — Quickstart

A collaborative sales CRM (companies, people, deals, notes, meetings, activities) built on the [Butterbase](https://butterbase.ai) platform.

**About "cloning" in this guide:** every time we say *clone*, we mean a **Butterbase app clone** — done either through the Butterbase MCP tool (`manage_app` action `clone`) or the CLI (`butterbase clone`). A Butterbase clone forks the live backend (schema, RLS policies, function code, auth/storage/realtime/AI configs, repo snapshot) into a brand-new `app_<id>` that *you* own, with its own URL, its own database, and its own API key. The source app is untouched. It also pulls the code snapshot into your local folder, so you have something to run.

**Pick your path:**

- **Path A — I just want to run the frontend against the existing shared backend.** Do § 1–4, skip § 5.
- **Path B — I'm cloning the Butterbase app to own my own independent copy.** Do § 1–2 (using a clone command), then § 5 (replaces § 3), then § 4.

---

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | ≥ 20 | `node -v` |
| npm | ≥ 10 | `npm -v` |
| butterbase CLI | ≥ 0.5 | `butterbase --version` |

If you intend to read or modify the live backend (schema, RLS, functions), you will also need:

- A Butterbase account with access to `app_44zjayftl7b3` (ask the project owner)
- `BUTTERBASE_API_KEY` exported in your shell, or written to `./.env` at the repo root
- `jq` and `curl` (for `backend/sync.sh`)

If you only want to run the frontend against the existing live backend, **none of the backend tools are required**.

---

## 2. Clone & install

There are three ways to get a working copy of this project. **All three are Butterbase clones** — they go through the platform, not any external code host. Pick whichever fits how you work:

**Option A — CLI clone** (one command, recommended for most people):

```bash
butterbase clone app_44zjayftl7b3 butterbaseCRM
# Optional flags:
#   --name "My CRM"        Name for the new app (default: "Clone of app_44zjayftl7b3")
#   --region us-east-1     Region for the new app (default: source's region)
cd butterbaseCRM
```

This creates a brand-new app you own, copies the schema/RLS/functions/auth/storage/realtime/AI configs into it, and writes the latest code snapshot into `./butterbaseCRM/`.

**Option B — MCP clone** (when you're already driving Butterbase from inside an AI agent / Claude Code):

```
manage_app  action=clone  source_app_id=app_44zjayftl7b3  name="My CRM"
# returns { job_id }; poll with:
manage_app  action=get_clone_job  job_id=<id>
# when status=ready, returns { dest_app_id }
```

Then in any local folder:

```bash
butterbase init --app <dest_app_id>        # bind the folder to the new app
butterbase repo pull                       # download the snapshot into this folder
```

**Option C — `butterbase repo pull` only** (you already have an app id, just want its code):

```bash
mkdir butterbaseCRM && cd butterbaseCRM
butterbase init --app <your_app_id>        # bind to an existing app
butterbase repo pull                       # download the latest snapshot
```

After any of the three, install frontend deps:

```bash
cd frontend
npm install
```

> See § 9 for the full repo-sync workflow (push, pull, snapshot pinning).

---

## 3. Configure environment (Path A — shared backend)

The frontend reads two Vite env vars. Create `frontend/.env.local`:

```bash
# frontend/.env.local
VITE_BUTTERBASE_APP_ID=app_44zjayftl7b3
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai/v1/app_44zjayftl7b3
```

That's it — auth, storage, realtime, AI, and functions all go through the same base URL via `@butterbase/sdk`.

> If you instead cloned the Butterbase app, **skip this section** and do § 5 — you'll point the frontend at *your* app, not the shared one.

---

## 4. Run the dev server

```bash
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

You should land on the sign-in page. Either:

- **Sign in with Google** (one of the configured OAuth providers), or
- **Create an account** with email + password.

The first time you log in you'll be prompted to create or join a **workspace** — every record (company, deal, note…) is scoped to a workspace, and RLS will hide rows you don't have a membership for.

---

## 5. Path B — you cloned the Butterbase app

When you clone the app in the Butterbase dashboard (or via `manage_app` clone), Butterbase copies the **schema, RLS policies, function code, storage/realtime/AI configs, and integration toolkit list** into a brand-new app id (e.g. `app_xyz123`).

What does **NOT** carry over from the original — you have to set these on your clone before things work:

### 5.1 Function env vars (`ctx.env`)

Every function reads from `ctx.env`, and **function env vars are per-app secrets** — your clone starts with an empty set. Until you populate these, calls to `summarize-company`, `invite-member`, `enrich-*`, etc. will fail with `undefined` URLs or missing-auth errors.

Required for any AI-using or self-calling function (almost all of them):

| Var | Value | Why |
|---|---|---|
| `BUTTERBASE_API_URL` | `https://api.butterbase.ai` | base URL functions use to call the platform |
| `BUTTERBASE_APP_ID` | **your** new `app_<id>` (NOT `app_44zjayftl7b3`) | functions hit `${URL}/v1/${APP_ID}/...` |
| `BUTTERBASE_API_KEY` | service API key issued for your clone | bearer token on every self-call |

Required for `invite-member`:

| Var | Value |
|---|---|
| `FRONTEND_URL` | the URL where you deploy the frontend (e.g. `https://crm.yourdomain.com` or `http://localhost:5173` for local dev) — used to build `/invite/<token>` links inside the email |

> Enrichment (`enrich-company`, `enrich-person`) does **not** need any third-party API keys. It runs entirely through the Butterbase AI gateway and the in-app copilot agent. See the `crm-enrichment` skill in `.claude/skills/` for how to drive enrichment from the agent.

Set the required vars with the MCP tool or CLI:

```bash
# Via MCP (in Claude Code / any MCP client)
manage_function set_env --name summarize-company --env '{"BUTTERBASE_API_URL":"https://api.butterbase.ai","BUTTERBASE_APP_ID":"app_xyz123","BUTTERBASE_API_KEY":"bb_..."}'

# …repeat per function, or set them at app-default scope if your dashboard supports it.
```

### 5.2 Auth providers (OAuth)

Google OAuth is configured on the original app with a client_id/secret that points to its redirect URI. Your clone gets the *provider list* but **not the secrets**, and the redirect URI won't match yours anyway. Either:

- Disable Google in `manage_auth_config` and use email/password only, or
- Create your own Google OAuth client (Cloud Console → OAuth 2.0 Client) and run `manage_oauth configure --provider google --client_id ... --client_secret ... --redirect_uris https://api.butterbase.ai/v1/app_xyz123/auth/callback/google`.

### 5.3 Composio integrations (Gmail, etc.)

The integration *toolkit list* (Gmail, Google Calendar) is copied, but **end-user connections are not** — every workspace member who wants to send invites / ingest mail will re-connect their account via the in-app flow on first use. No action required from you as the app owner unless you want to swap Composio API credentials.

### 5.4 Substrate link (optional)

If you want `ctx.substrate` to work inside functions (used for cross-app entity sync of Companies/People), link the cloned app to your substrate user in the dashboard. Skip this if you're not using substrate.

### 5.5 Frontend env for your clone

After § 5.1–5.4, point the frontend at *your* app:

```bash
# frontend/.env.local
VITE_BUTTERBASE_APP_ID=app_xyz123                              # your new id
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai/v1/app_xyz123
```

### 5.6 First-run sanity check

Smoke-test in order — if one step fails, fix it before moving on:

1. `manage_app get --app_id app_xyz123` returns your app (✓ clone exists)
2. `select_rows --table workspaces --limit 1` returns `[]` cleanly (✓ DB + RLS reachable, just empty)
3. Sign up + create a workspace from the frontend (✓ auth + RLS write path)
4. `invoke_function --name summarize-company --body '{"company_id":"<id>"}'` returns 200 (✓ `ctx.env` and AI gateway wired)
5. Send a workspace invite (✓ `FRONTEND_URL` + Gmail integration)

---

## 6. Repo layout

```
butterbaseCRM/
├── frontend/                  ← the React app you just ran
│   ├── src/
│   │   ├── pages/             ← 16 routes (Companies, Deals, Meetings, Auth, …)
│   │   ├── components/        ← shadcn/ui-based UI primitives + feature components
│   │   ├── hooks/             ← useCompanies, useDeals, useAuth, useRealtime, …
│   │   ├── lib/butterbase.ts  ← the SDK client — every API call flows through here
│   │   ├── lib/realtime.ts    ← WebSocket subscription wiring
│   │   ├── lib/activity.ts    ← writes activity-log rows after mutations
│   │   ├── routes/            ← React Router v7 config
│   │   └── App.tsx            ← Router + QueryClient + RealtimeBoot
│   └── .env.local             ← you just created this
│
├── backend/                   ← READ-ONLY MIRROR of the live platform state
│   ├── schema.json            ← 11 tables, indexes
│   ├── rls/policies.sql       ← workspace-scoped RLS policies
│   ├── functions/             ← summarize-company, invite-member, accept-invite
│   ├── auth/, storage.json, realtime.json, ai.json, integrations/
│   └── sync.sh                ← refreshes the mirror from the live app
│
├── docs/butterbase/           ← Journey artifacts
│   ├── 01-idea.md             ← Product vision
│   ├── 02-plan.md             ← Schema + RLS + function design
│   └── 03-preflight.md        ← Account / MCP / app-id check
│
└── .butterbase/config.json    ← pinned app id + snapshot
```

---

## 7. Where to make changes

| What you want to change | Where to edit |
|---|---|
| A page, route, or layout | `frontend/src/pages/` & `frontend/src/routes/` |
| A reusable UI component | `frontend/src/components/` |
| How data is fetched/mutated | `frontend/src/hooks/use*.ts` |
| SDK / API client config | `frontend/src/lib/butterbase.ts` |
| Realtime subscriptions | `frontend/src/lib/realtime.ts` |
| Styling / theme | `frontend/tailwind.config.js`, `frontend/src/index.css` |

**Backend changes are NOT made by editing `backend/` files.** That folder is a snapshot. To change the live app you must:

1. Use the Butterbase MCP tools (`manage_schema`, `manage_rls`, `deploy_function`, etc.) or the dashboard.
2. Then run `cd backend && ./sync.sh` to refresh the mirror so the repo reflects the new live state.
3. Commit the regenerated files.

See `backend/README.md` for the full backend reference.

---

## 8. Common commands

From `frontend/`:

```bash
npm run dev        # Vite dev server with HMR
npm run build      # tsc -b && vite build  → dist/
npm run preview    # serve the production build locally
npm run lint       # ESLint
```

From `backend/` (requires `BUTTERBASE_API_KEY`):

```bash
./sync.sh          # pull current schema/RLS/functions/auth/etc. into this folder
```

Repo sync — see § 9 for the full story:

```bash
butterbase repo pull                       # download the latest code snapshot
butterbase repo push --message "..."       # upload your working tree as a new snapshot
butterbase repo status                     # show pinned vs. latest snapshot
```

---

## 9. Syncing code with the Butterbase repo

Every Butterbase app has a **content-addressed code repo on the platform**. It stores immutable snapshots of your project tree, identified by a sha. The repo is what populates a freshly-cloned app for new collaborators, and what backs `butterbase repo pull` / `butterbase repo push`.

```
your laptop                    Butterbase platform
─────────────                  ─────────────────────
working tree  ── push ────►    snapshot 8034d485…  (latest)
              ◄── pull ────                snapshot c887118…
                              .butterbase/config.json.pinned_snapshot_id
                                       points at one of these
```

### 9.1 `butterbase repo pull` — get the platform's code onto your machine

Use this when:

- You just cloned the Butterbase app and have no local code yet.
- A teammate pushed and you want their changes.
- You want to reset your working tree to the last platform snapshot.

```bash
butterbase repo pull                       # latest snapshot for the bound app
butterbase repo pull --snapshot <sha>      # a specific historical snapshot
butterbase repo pull --app <app_id>        # override the bound app
```

The pull writes files into the current directory, honouring `.butterbaseignore`. It does **not** touch `node_modules/`, `.env*`, or anything else excluded by the ignore rules.

### 9.2 `butterbase repo push` — upload your working tree as a new snapshot

Use this when:

- You changed code locally and want it to become the new canonical snapshot.
- You want to share your changes with a teammate who'll `pull`.
- You want a restorable point you can roll back to.

```bash
butterbase repo push --message "short summary"   # required: a commit-style message
butterbase repo push --dry-run                   # show the manifest without uploading
butterbase repo push --json                      # machine-readable output
```

Push is content-addressed and incremental — only blobs new to the platform are uploaded, so a 200-file repo with one edit pushes ~one file. After a successful push the CLI prints the new snapshot id (e.g. `Committed 8034d485…`).

### 9.3 What does and does NOT ship

- `.butterbaseignore` is the source of truth for what to exclude. The CLI ships with sensible defaults always-ignored: `node_modules/`, `dist/`, `.next/`, `.turbo/`, `.DS_Store`, `.butterbase/`.
- Add anything else you don't want shipped to `.butterbaseignore` (one pattern per line). Common additions for this repo:
  ```
  # .butterbaseignore
  .playwright-mcp/
  frontend/frontend.zip
  frontend/.env.local
  ```
- **Secrets:** `.env.local` and `.env` are **not** butterbase-ignored by default — they will be uploaded into the snapshot unless you list them in `.butterbaseignore`. Add them explicitly:
  ```
  .env
  .env.local
  .env.*.local
  ```

### 9.4 Pinned vs. latest snapshot

`.butterbase/config.json` has a `pinned_snapshot_id` field. Pinning is opt-in — it lets you say "for this checkout, treat this snapshot as the source of truth" so a casual `repo pull` doesn't yank you forward to whatever someone else just pushed. Check pinned vs. latest with:

```bash
butterbase repo status                     # shows pinned_snapshot_id, remote_latest_snapshot_id, file_count
butterbase repo list-snapshots             # full history newest-first
```

To advance the pin to the latest snapshot after a `pull`:

```bash
butterbase repo pin --latest               # or `butterbase repo pin <sha>`
```

### 9.5 Typical workflows

**Solo dev, one machine:**

```bash
# edit code…
butterbase repo push --message "what I changed"
```

**Cloned an app, want to start hacking on it:**

```bash
butterbase init                            # bind the folder to the app
butterbase repo pull                       # populate the working tree
cd frontend && npm install
npm run dev                                # iterate
butterbase repo push --message "..."       # ship changes
```

**Two teammates collaborating on the same app:**

```bash
# Teammate A
butterbase repo push --message "added meeting brief tool"

# Teammate B
butterbase repo pull                       # picks up A's changes
# …make further edits…
butterbase repo push --message "follow-up tweaks"
```

> Reminder: the code repo and the deployed *functions* are separate. Pushing code to `repo push` does **NOT** redeploy `enrich-company`, `agent-chat`, etc. — those still need `deploy_function` (via MCP/CLI). The repo snapshot is the source-of-truth tree; deployment is a separate step against the live function runtime.

---

## 10. Architecture cheat-sheet

- **Database** — Postgres, 11 tables, RLS on every table. Every row keyed on `workspace_id`; access goes through the `memberships` table.
- **Auth** — email/password + Google OAuth, via Butterbase. JWT is attached to every request by `@butterbase/sdk`.
- **Realtime** — WebSocket subscriptions on 7 tables. Row events invalidate the matching React Query caches automatically — no manual refetch in components.
- **Storage** — presigned-URL upload flow (10 MB / file). See `frontend/src/lib/storage.ts`.
- **Functions** — TypeScript handlers deployed to Butterbase, invoked via the SDK:
  - `summarize-company` — AI overview of a company
  - `invite-member` — emails a workspace invite (Composio + Gmail)
  - `accept-invite` — redeems an invite token
- **AI** — Anthropic Claude Haiku 4.5 via the Butterbase gateway. No API key needed in the frontend.
- **Substrate** — Companies & People are exported as substrate entities for cross-app identity.

For the full design rationale read `docs/butterbase/02-plan.md`.

---

## 11. Troubleshooting

**`401 Unauthorized` on every request.** The session JWT expired or the `VITE_BUTTERBASE_API_URL` is wrong. Sign out + sign back in; double-check `.env.local`.

**Logged in but every list is empty.** Expected behaviour — you have no `memberships` row in any workspace yet. Create a workspace from the sidebar / onboarding flow; you'll be inserted as the founding owner.

**Blank page after `npm run build && npm run preview`.** Vite needs `VITE_*` vars present at *build* time, not just at dev. Make sure `.env.local` exists before running `npm run build`.

**Realtime doesn't update.** Open devtools → Network → WS. You should see one open WebSocket to `api.butterbase.ai`. If not, your JWT didn't reach `RealtimeBoot` in `App.tsx`.

**`backend/sync.sh` fails with "set BUTTERBASE_API_KEY".** Put it in `./.env` at the repo root (not inside `backend/`), or `export BUTTERBASE_API_KEY=...` in your shell.

**(Path B) Function 500s with `TypeError: ... undefined ... fetch`.** You forgot to set `BUTTERBASE_API_URL` / `BUTTERBASE_APP_ID` / `BUTTERBASE_API_KEY` on the cloned function. See § 5.1.

**(Path B) Invite emails arrive but the link is broken / points to localhost.** `FRONTEND_URL` on `invite-member` is wrong or unset. See § 5.1.

**(Path B) "Sign in with Google" loops or errors with `redirect_uri_mismatch`.** The cloned app inherited the provider list but not your Google client. Either disable Google or run `manage_oauth configure` with your own client and redirect URI. See § 5.2.

**(Path B) AI calls return 401 from the AI gateway.** `BUTTERBASE_API_KEY` is either unset on the function or is a key from the *original* app. Issue a new key for the cloned app and re-set the env var.

---

## 12. Next steps

- Read `docs/butterbase/01-idea.md` for the product vision.
- Read `docs/butterbase/02-plan.md` for the data model and RLS rules.
- Read `backend/README.md` for the full backend reference.
- Browse `frontend/src/pages/` to see how each surface is wired up.

Happy hacking.
