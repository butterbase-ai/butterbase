# Frontend Spec — butterbase-crm

A self-contained build spec for the Vite + React + shadcn frontend. A fresh agent context can pick this up and ship without consulting earlier docs. Where backend behavior matters, the relevant facts are inlined.

> **Note (restored 2026-06-02):** docs 01–04 were lost in a scaffolding mishap and could not be recovered. The frontend now lives under the `frontend/` subdirectory of the repo; the repo root is reserved for backend code. All paths in this spec are relative to `frontend/`.

## 0. Live backend reference (do not re-provision)

| | |
|---|---|
| `app_id` | `app_44zjayftl7b3` |
| `api_base` | `https://api.butterbase.ai/v1/app_44zjayftl7b3` |
| subdomain | `butterbase-crm.butterbase.dev` (target for prod deploy) |
| dev origin | `http://localhost:5173` (already in CORS) |
| OAuth callback | `https://api.butterbase.ai/auth/app_44zjayftl7b3/oauth/google/callback` (Google registered) |
| AI model | `anthropic/claude-haiku-4.5` (only allowed model) |
| Realtime tables | companies, people, deals, notes, meetings, activities, attachments |
| Functions | `summarize-company` (POST, auth required) |
| Service key | in root `.env` as `BUTTERBASE_API_KEY` — **do not import into the frontend**. The browser uses end-user JWTs. |

The full schema + RLS shape is below (sections 5–6). The two non-obvious behaviors:

1. **Workspace bootstrap.** When a user signs up and creates a workspace, the same caller must then insert their own `memberships` row with `role='owner'`. There's an RLS carve-out (`memberships_insert_founding_owner`) that allows this iff `workspaces.owner_user_id = current_user_id()`.
2. **Activity log is app-code-written** (decision B2). After every mutation that should be visible in the activity feed, the frontend INSERTs an `activities` row with `actor_user_id = <current user>` and a kind like `company.created`, `deal.stage_changed`, etc. RLS policy `activities_insert_member` allows this.

## 1. Stack & dependencies

- **Vite** + **React 18** + **TypeScript** (strict)
- **shadcn/ui** + **Tailwind CSS** v3
- **React Router** v6 (data router optional; standard `<BrowserRouter>` is fine)
- **TanStack Query** v5
- **Zustand** for tiny global UI state (workspace switcher, modal open/close)
- **@butterbase/sdk** for auth, db, storage, realtime, functions
- **zod** for form schemas
- **react-hook-form** for forms
- **date-fns** for date formatting
- **lucide-react** for icons (shadcn convention)
- **clsx** + **tailwind-merge** (shadcn convention; bundled by shadcn init)

## 2. Env vars

`frontend/.env.local` (gitignored):

```
VITE_BUTTERBASE_APP_ID=app_44zjayftl7b3
VITE_BUTTERBASE_API_URL=https://api.butterbase.ai
```

Note `apiUrl` is the host (no `/v1/{app_id}` suffix) — the SDK appends paths itself.

## 3. File tree (under `frontend/`)

```
src/
  main.tsx
  App.tsx                       // top-level <Router>, <QueryClientProvider>, <Toaster>
  index.css                     // tailwind + shadcn vars
  lib/
    butterbase.ts               // export const bb = createClient({...})
    types.ts                    // Workspace, Membership, Company, Person, Deal, Note, Meeting, MeetingAttendee, Activity, Attachment
    activity.ts                 // logActivity(kind, entity_type, entity_id, payload?) helper
    storage.ts                  // useDownloadUrl(objectId) hook + uploadFile() helper
    realtime.ts                 // useRealtimeInvalidation() — subscribes + invalidates Query cache
    workspace.ts                // useCurrentWorkspace() — zustand store + persistence
    queryKeys.ts                // centralized TanStack query keys
  routes/
    index.tsx                   // router config
    AuthGuard.tsx               // redirects to /login if no session
    WorkspaceGuard.tsx          // redirects to /onboard if user has no membership
  pages/
    Login.tsx                   // email/password + Google button
    OAuthCallback.tsx           // /auth/callback — parses ?access_token=...&refresh_token=...
    Onboard.tsx                 // create first workspace
    WorkspaceSwitcher.tsx       // dropdown in topbar
    CompaniesList.tsx           // DEFAULT route after auth
    CompanyDetail.tsx
    DealsKanban.tsx
    ActivityFeed.tsx
    Settings.tsx                // members, workspace name, etc.
  components/
    AppShell.tsx                // sidebar + topbar layout
    Sidebar.tsx
    Topbar.tsx
    EntityAvatar.tsx            // logo/avatar with storage download URL
    NewCompanyDialog.tsx
    NewPersonDialog.tsx
    NewDealDialog.tsx
    NewNoteDialog.tsx
    NewMeetingDialog.tsx
    DealCard.tsx                // for kanban column
    NotesPanel.tsx              // used inside CompanyDetail
    MeetingsPanel.tsx
    AttachmentsPanel.tsx
    SummarizeButton.tsx         // calls summarize-company function
    InlineEditCell.tsx          // for the Companies table inline-edit
  hooks/
    useCompanies.ts
    useCompany.ts
    usePeople.ts
    useDeals.ts
    useNotes.ts
    useMeetings.ts
    useActivities.ts
    useAttachments.ts
    useMemberships.ts
    useWorkspaces.ts
public/
  favicon.svg
```

## 4. Bootstrap: SDK client + providers

```ts
// src/lib/butterbase.ts
import { createClient } from '@butterbase/sdk';

export const bb = createClient({
  appId: import.meta.env.VITE_BUTTERBASE_APP_ID!,
  apiUrl: import.meta.env.VITE_BUTTERBASE_API_URL!,
});
```

```tsx
// src/App.tsx
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { AppRoutes } from './routes';
import { useRealtimeInvalidation } from './lib/realtime';

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

function RealtimeBoot() { useRealtimeInvalidation(); return null; }

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <RealtimeBoot />
        <AppRoutes />
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
```

## 5. Schema reference (read-only — already applied)

All tables include `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz default now()` unless noted. All app tables include `workspace_id uuid not null references workspaces(id) on delete cascade` except `workspaces` and `memberships` themselves.

- **workspaces**: name, slug (unique), owner_user_id, created_at, updated_at
- **memberships**: workspace_id, user_id, role (`owner`|`admin`|`member`, default `member`), created_at. Unique on `(workspace_id, user_id)`.
- **companies**: workspace_id, name, domain, logo_object_id, industry, employee_count, location, description, **ai_summary**, **ai_summary_at**, created_by
- **people**: workspace_id, company_id (nullable, SET NULL on parent delete), first_name, last_name, email, phone, title, avatar_object_id, linkedin_url, created_by
- **deals**: workspace_id, name, company_id (nullable), primary_person_id (nullable), stage (`lead`|`qualified`|`proposal`|`negotiation`|`won`|`lost`, default `lead`), amount_cents, currency (default `USD`), close_date (date), owner_user_id, created_by
- **notes**: workspace_id, entity_type (`company`|`person`|`deal`), entity_id, body, created_by
- **meetings**: workspace_id, title, starts_at, ends_at, location, notes (text), company_id, deal_id, created_by
- **meeting_attendees**: workspace_id, meeting_id, person_id (nullable), external_email, response (`accepted`|`declined`|`tentative`|`pending`, default `pending`). Unique on `(meeting_id, person_id)`.
- **activities**: workspace_id, actor_user_id, kind, entity_type, entity_id, payload (jsonb), created_at
- **attachments**: workspace_id, entity_type, entity_id, object_id, filename, content_type, size_bytes, uploaded_by, created_at

### TypeScript types (`src/lib/types.ts`)

```ts
export type Role = 'owner' | 'admin' | 'member';
export type DealStage = 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost';
export type EntityType = 'company' | 'person' | 'deal' | 'note' | 'meeting';
export type MeetingResponse = 'accepted' | 'declined' | 'tentative' | 'pending';

export interface Workspace { id: string; name: string; slug: string; owner_user_id: string; created_at: string; updated_at: string }
export interface Membership { id: string; workspace_id: string; user_id: string; role: Role; created_at: string }
export interface Company { id: string; workspace_id: string; name: string; domain: string | null; logo_object_id: string | null; industry: string | null; employee_count: number | null; location: string | null; description: string | null; ai_summary: string | null; ai_summary_at: string | null; created_by: string; created_at: string; updated_at: string }
export interface Person { id: string; workspace_id: string; company_id: string | null; first_name: string | null; last_name: string | null; email: string | null; phone: string | null; title: string | null; avatar_object_id: string | null; linkedin_url: string | null; created_by: string; created_at: string; updated_at: string }
export interface Deal { id: string; workspace_id: string; name: string; company_id: string | null; primary_person_id: string | null; stage: DealStage; amount_cents: number | null; currency: string; close_date: string | null; owner_user_id: string; created_by: string; created_at: string; updated_at: string }
export interface Note { id: string; workspace_id: string; entity_type: EntityType; entity_id: string; body: string; created_by: string; created_at: string; updated_at: string }
export interface Meeting { id: string; workspace_id: string; title: string; starts_at: string; ends_at: string | null; location: string | null; notes: string | null; company_id: string | null; deal_id: string | null; created_by: string; created_at: string; updated_at: string }
export interface MeetingAttendee { id: string; workspace_id: string; meeting_id: string; person_id: string | null; external_email: string | null; response: MeetingResponse; created_at: string }
export interface Activity { id: string; workspace_id: string; actor_user_id: string; kind: string; entity_type: EntityType; entity_id: string; payload: Record<string, unknown> | null; created_at: string }
export interface Attachment { id: string; workspace_id: string; entity_type: EntityType; entity_id: string; object_id: string; filename: string; content_type: string | null; size_bytes: number | null; uploaded_by: string; created_at: string }
```

## 6. RLS reference (read-only — already installed)

Key implications for the frontend:

- **Every query is filtered by membership automatically.** No need to add `.eq('workspace_id', ...)` for safety — the policies enforce it. Still pass it for index use and to avoid cross-workspace cache pollution.
- **Inserting `companies`/`people` auto-populates `created_by`** via a BEFORE INSERT trigger installed by the policy's `user_column='created_by'`. Don't set it explicitly. Same for `deals`/`notes`/`meetings` (created_by) and `attachments` (uploaded_by).
- **`deals.owner_user_id` is NOT auto-populated.** The frontend must set it (typically = current user) when creating a deal.
- **`workspaces.owner_user_id` is NOT auto-populated.** Set it explicitly on workspace creation.
- **`activities.actor_user_id` is NOT auto-populated.** The frontend logs activity rows manually — see §10.
- **UPDATE/DELETE on deals/notes/meetings/attachments** require the caller to be either `created_by`/`uploaded_by` OR a workspace `owner`/`admin`. Show a disabled state for rows the current user can't edit (compare `created_by` to `auth.getUser().id`).

## 7. Routing

```
/login                              → Login (redirect to / if already authed)
/auth/callback                      → OAuthCallback (Google redirects here with tokens in querystring)
/onboard                            → Onboard (create first workspace) — for new users
/                                   → redirect to /companies
/companies                          → CompaniesList (DEFAULT)
/companies/:id                      → CompanyDetail
/people                             → (list, similar to CompaniesList)
/deals                              → DealsKanban
/activity                           → ActivityFeed
/settings                           → Settings (members, workspace name, leave/delete)
```

`AuthGuard` wraps everything except `/login` and `/auth/callback`. Reads `bb.auth.getUser()` (and listens via `onAuthStateChange`) — redirect to `/login` if no session.

`WorkspaceGuard` wraps everything except `/onboard`, `/login`, `/auth/callback`. Reads memberships for the current user (via `useMemberships()`); if empty, redirect to `/onboard`.

## 8. Auth flow

### Sign up / log in (email + password)

```ts
await bb.auth.signUp({ email, password, display_name });
// Verification code emailed; show a "enter code" screen.
await bb.auth.verifyEmail({ email, code });
const { data, error } = await bb.auth.signIn({ email, password });
```

### Google OAuth

```ts
const { url } = bb.auth.signInWithOAuth({
  provider: 'google',
  redirectTo: `${window.location.origin}/auth/callback`,
});
window.location.href = url;
```

`OAuthCallback` page parses `?access_token=...&refresh_token=...&expires_in=...` from the URL, calls the SDK setter (`bb.auth.setSession` if available, else write to localStorage in the shape the SDK expects), then `navigate('/', { replace: true })`.

### Active workspace

Per-tab state in a Zustand store, persisted to `localStorage` under `crm.workspace`. No workspace claim in the JWT.

```ts
// src/lib/workspace.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WS {
  workspaceId: string | null;
  setWorkspace: (id: string | null) => void;
}
export const useWorkspaceStore = create<WS>()(
  persist(
    (set) => ({ workspaceId: null, setWorkspace: (id) => set({ workspaceId: id }) }),
    { name: 'crm.workspace' },
  ),
);

export function useCurrentWorkspaceId(): string {
  const id = useWorkspaceStore((s) => s.workspaceId);
  if (!id) throw new Error('No active workspace');
  return id;
}
```

The `<WorkspaceSwitcher>` dropdown lists `useMemberships()` joined to `useWorkspaces()` and calls `setWorkspace(id)`. On change, call `queryClient.invalidateQueries()` to refetch everything.

### Workspace creation (onboarding)

```ts
const user = (await bb.auth.getUser()).data!;
const { data: ws } = await bb.from<Workspace>('workspaces').insert({
  name, slug, owner_user_id: user.id,
}).select().single();
await bb.from<Membership>('memberships').insert({
  workspace_id: ws.id, user_id: user.id, role: 'owner',
});
setWorkspace(ws.id);
navigate('/companies');
```

The second insert succeeds via the `memberships_insert_founding_owner` policy carve-out.

## 9. Data layer

### TanStack query keys

```ts
// src/lib/queryKeys.ts
export const qk = {
  workspaces: () => ['workspaces'] as const,
  memberships: (workspaceId?: string) => ['memberships', workspaceId] as const,
  companies: (workspaceId: string) => ['companies', workspaceId] as const,
  company: (id: string) => ['company', id] as const,
  people: (workspaceId: string) => ['people', workspaceId] as const,
  deals: (workspaceId: string) => ['deals', workspaceId] as const,
  notes: (entityType: string, entityId: string) => ['notes', entityType, entityId] as const,
  meetings: (workspaceId: string) => ['meetings', workspaceId] as const,
  activities: (workspaceId: string) => ['activities', workspaceId] as const,
  attachments: (entityType: string, entityId: string) => ['attachments', entityType, entityId] as const,
};
```

### One hook per table (pattern)

```ts
// src/hooks/useCompanies.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/lib/butterbase';
import { qk } from '@/lib/queryKeys';
import { useCurrentWorkspaceId } from '@/lib/workspace';
import { logActivity } from '@/lib/activity';
import type { Company } from '@/lib/types';

export function useCompanies() {
  const ws = useCurrentWorkspaceId();
  return useQuery({
    queryKey: qk.companies(ws),
    queryFn: async () => {
      const { data, error } = await bb.from<Company>('companies').select('*').eq('workspace_id', ws).order('updated_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCreateCompany() {
  const ws = useCurrentWorkspaceId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Company> & { name: string }) => {
      const { data, error } = await bb.from<Company>('companies').insert({ ...input, workspace_id: ws }).select().single();
      if (error) throw error;
      await logActivity('company.created', 'company', data.id, { name: data.name });
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.companies(ws) }),
  });
}

export function useUpdateCompany() {
  const qc = useQueryClient();
  const ws = useCurrentWorkspaceId();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Company> }) => {
      const { data, error } = await bb.from<Company>('companies').update(patch).eq('id', id).select().single();
      if (error) throw error;
      await logActivity('company.updated', 'company', id, { fields: Object.keys(patch) });
      return data;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: qk.companies(ws) });
      qc.invalidateQueries({ queryKey: qk.company(vars.id) });
    },
  });
}
```

Repeat the pattern for people, deals (with `stage_changed` activity kind detection), notes, meetings, meeting_attendees, activities, attachments.

## 10. Activity logging helper

```ts
// src/lib/activity.ts
import { bb } from './butterbase';
import { useWorkspaceStore } from './workspace';

export async function logActivity(
  kind: string,
  entity_type: 'company' | 'person' | 'deal' | 'note' | 'meeting',
  entity_id: string,
  payload?: Record<string, unknown>,
) {
  const workspace_id = useWorkspaceStore.getState().workspaceId;
  const user = (await bb.auth.getUser()).data;
  if (!workspace_id || !user) return;
  await bb.from('activities').insert({
    workspace_id,
    actor_user_id: user.id,
    kind,
    entity_type,
    entity_id,
    payload: payload ?? null,
  });
}
```

**Activity kinds (canonical list — emit exactly these):**

- `company.created`, `company.updated`, `company.deleted`
- `person.created`, `person.updated`, `person.deleted`
- `deal.created`, `deal.updated`, `deal.deleted`, `deal.stage_changed` (payload: `{from, to}`)
- `note.created`, `note.deleted`
- `meeting.created`, `meeting.updated`, `meeting.deleted`

For `useUpdateDeal`, detect stage change inside the mutation:

```ts
if (patch.stage && patch.stage !== old.stage) {
  await logActivity('deal.stage_changed', 'deal', id, { from: old.stage, to: patch.stage });
} else {
  await logActivity('deal.updated', 'deal', id, { fields: Object.keys(patch) });
}
```

## 11. Realtime invalidation

```ts
// src/lib/realtime.ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bb } from './butterbase';
import { qk } from './queryKeys';
import { useWorkspaceStore } from './workspace';

const tablesToWatch = ['companies', 'people', 'deals', 'notes', 'meetings', 'activities', 'attachments'] as const;

export function useRealtimeInvalidation() {
  const qc = useQueryClient();
  const wsId = useWorkspaceStore((s) => s.workspaceId);

  useEffect(() => {
    if (!wsId) return;
    const channels = tablesToWatch.map((table) => {
      return bb.realtime.subscribe({ table }, (change) => {
        switch (table) {
          case 'companies':
            qc.invalidateQueries({ queryKey: qk.companies(wsId) });
            if (change.record?.id) qc.invalidateQueries({ queryKey: qk.company(change.record.id) });
            break;
          case 'people': qc.invalidateQueries({ queryKey: qk.people(wsId) }); break;
          case 'deals': qc.invalidateQueries({ queryKey: qk.deals(wsId) }); break;
          case 'notes': qc.invalidateQueries({ queryKey: ['notes'] }); break;
          case 'meetings': qc.invalidateQueries({ queryKey: qk.meetings(wsId) }); break;
          case 'activities': qc.invalidateQueries({ queryKey: qk.activities(wsId) }); break;
          case 'attachments': qc.invalidateQueries({ queryKey: ['attachments'] }); break;
        }
      });
    });
    return () => { for (const c of channels) c.unsubscribe(); };
  }, [wsId, qc]);
}
```

> If the SDK's realtime helper signature differs, use the raw WS pattern: `wss://api.butterbase.ai/v1/app_44zjayftl7b3/realtime?token=<jwt>`, send `{type:"subscribe", table}` after `connected`, react to `{type:"change", table, op, record, old_record}`. **Browsers must use `?token=`; `Authorization` headers are not allowed on WebSocket upgrades.**

## 12. Storage helpers

```ts
// src/lib/storage.ts
import { useQuery } from '@tanstack/react-query';
import { bb } from './butterbase';

export function useDownloadUrl(objectId: string | null | undefined) {
  return useQuery({
    queryKey: ['downloadUrl', objectId],
    queryFn: async () => {
      if (!objectId) return null;
      const { data, error } = await bb.storage.getDownloadUrl(objectId);
      if (error) throw error;
      return data?.url ?? null;
    },
    enabled: !!objectId,
    staleTime: 50 * 60 * 1000,
  });
}

export async function uploadFile(file: File, opts?: { public?: boolean }) {
  const { data, error } = await bb.storage.upload(file, { public: opts?.public ?? false });
  if (error) throw error;
  return data; // { objectId, ... }
}
```

`<EntityAvatar src={logo_object_id} fallback={name} />` uses `useDownloadUrl` internally; render a skeleton until the URL resolves, then `<img src={url}>`.

**Persist `objectId`, never `objectKey`.** Schema columns are correctly named (`logo_object_id`, `avatar_object_id`, `attachments.object_id`) — pass these strings to `getDownloadUrl`.

## 13. Screens

### `Login.tsx`
- Email + password form (zod validated).
- "Continue with Google" button → `signInWithOAuth`.
- "Don't have an account? Sign up" toggles between login / signup / verify-code modes.

### `OAuthCallback.tsx`
- Parse `?access_token`, `?refresh_token`, `?expires_in` from `location.search`.
- Hand to SDK session setter.
- `navigate('/', { replace: true })`.

### `Onboard.tsx`
- Shown if `useMemberships()` returns empty.
- One form: workspace `name` + `slug` (auto-derived from name, editable). Submit triggers workspace+membership insert (§8).

### `WorkspaceSwitcher`
- shadcn `<DropdownMenu>` in the topbar.
- Lists current memberships joined to workspaces.
- "+ Create new workspace" link → reuses `Onboard` as a modal.

### `CompaniesList` (DEFAULT after auth)
- shadcn `<Table>` with columns: Logo, Name, Domain, Industry, Location, Employees, Updated.
- Each row clickable → `/companies/:id`.
- **Inline edit** for Name / Domain / Industry / Location via `<InlineEditCell>`. Press Enter to save, Escape to cancel. On save → `useUpdateCompany`.
- Top toolbar: "+ New company" → `<NewCompanyDialog>`. Filter input filters client-side by name/domain.
- Empty state: friendly callout + the "+ New company" button.
- Show realtime updates by reacting to the invalidations triggered in §11.

### `CompanyDetail` (`/companies/:id`)
- Header: logo + name + domain + industry, with edit buttons.
- Left column: company fields (description, location, employees, created info).
- Right column tabs (shadcn `<Tabs>`): **Overview** (default), **People** (people linked to this company), **Deals**, **Notes**, **Meetings**, **Attachments**.
- **AI summary card** at the top of Overview tab: shows `company.ai_summary` if set; button "Regenerate" calls `summarize-company` via `bb.functions.invoke('summarize-company', { body: { company_id: id } })`. Loading state while pending; toast on error.
- Notes panel: list of `notes WHERE entity_type='company' AND entity_id=:id` newest first, with "+ Add note" textarea. On submit `useCreateNote` → logActivity('note.created'). Each note row has author, timestamp, body. Delete button visible only if `created_by === currentUser.id`.

### `DealsKanban` (`/deals`)
- 6 columns, one per stage (`lead`, `qualified`, `proposal`, `negotiation`, `won`, `lost`).
- Each `<DealCard>` shows: name, company name (lookup), amount (formatted with Intl), close date.
- **Drag-and-drop** between columns updates `deals.stage`. On drop → `useUpdateDeal({ id, patch: { stage } })`. The mutation's stage-change detection emits `deal.stage_changed`.
- "+ New deal" button opens `<NewDealDialog>`: name, company (combobox over companies), primary person (combobox), stage (default `lead`), amount, currency, close_date, owner (default current user).
- Use `@dnd-kit/core` for DnD. Install: `npm i @dnd-kit/core @dnd-kit/sortable`.

### `ActivityFeed` (`/activity`)
- Reverse-chronological list of `activities` rows for the workspace, paginated 50 at a time.
- Each row shows actor avatar (resolve user → ?), kind formatted ("Alice changed Acme Corp's stage from proposal → won"), entity link, timestamp ("3 minutes ago" via `date-fns/formatDistance`).
- Mapping helper:
  ```ts
  function describeActivity(a: Activity): string {
    switch (a.kind) {
      case 'company.created': return `created company ${(a.payload as any)?.name ?? ''}`;
      case 'deal.stage_changed': return `moved deal to ${(a.payload as any)?.to}`;
      // ...
    }
  }
  ```
- Filter chips: by entity_type, by actor.

### `Settings` (`/settings`)
- Tabs: **Workspace** (name, slug — edit), **Members** (list memberships, role badge; if current user is owner/admin: invite member by email, change role, remove).
- Inviting a member isn't covered in v1 backend — for now, "Invite" only adds an existing user by user_id (admin paste-in). Real invite flow is a v1.1 deferred item.

## 14. shadcn theming

Use Slate base color, light + dark mode. Add `<ThemeProvider>` from shadcn's recommended pattern. Top-right: theme toggle.

Tailwind config:

```js
// tailwind.config.js
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { /* shadcn defaults */ } },
  plugins: [require('tailwindcss-animate')],
};
```

## 15. Critical gotchas

1. **`current_user_id()::uuid`** is how RLS reads the caller. The frontend doesn't pass workspace_id in a JWT claim — it's pure client state.
2. **B2 activity logging is your responsibility.** Every mutation hook must log. No DB triggers will save you.
3. **Workspace creation = two inserts** (workspaces, then memberships) in the same authenticated session.
4. **`getDownloadUrl(objectId)`** — `objectId` is the UUID returned at upload time, persisted in our `*_object_id` columns. NEVER use `objectKey`.
5. **Realtime browser auth = query param.** `?token=<jwt>`.
6. **Frontend deploy zip must use forward-slash entry paths.** Build with `archiver` (Node) when deploy time comes.
7. **`deals.owner_user_id`, `deals.created_by`** — owner is the salesperson (can differ from creator). Default both to current user on creation.
8. **`memberships` SELECT policy is membership-scoped.** Showing teammate names requires per-user fetch via auth API; for v1 show truncated user_id.
9. **AI summary call** uses `bb.functions.invoke('summarize-company', { body: { company_id } })`. The function is auth: required.
10. **Free plan AI credits = $0.10 lifetime.** Surface a friendly error if 402 `insufficient_credits` ever comes back.

## 16. Acceptance criteria

Ship-ready when:

- [ ] `npm run build` succeeds with zero TS errors and zero unused-import warnings.
- [ ] `npm run dev` opens at http://localhost:5173 and the Login page renders.
- [ ] Signing up via email/password → verifying code → landing on `/onboard` → creating a workspace → landing on `/companies` works without errors in the console.
- [ ] Signing in with Google works (assuming Google OAuth was set up on Cloud Console — already done).
- [ ] In two browser tabs signed into the same workspace: a company created in tab A appears in tab B's list within ~2 seconds (realtime).
- [ ] Inline-editing a company name persists and refreshes via realtime in the other tab.
- [ ] Creating a deal then dragging it between two kanban columns persists, generates a `deal.stage_changed` activity row, and updates other tabs.
- [ ] The Activity Feed shows the events generated above in human-readable form.
- [ ] Clicking "Regenerate" on the AI summary card returns a sensible 2-sentence summary and persists to `companies.ai_summary`.
- [ ] A non-author trying to edit someone else's deal/note/meeting/attachment is blocked with a clear toast.

## 17. Out of scope for v1 frontend

- Custom field definitions
- Tags / labels
- Email integration
- Real invite flow
- Bulk CSV import
- Saved views / filters
- Mobile-first responsive polish (build desktop-first, ~1024px+)
