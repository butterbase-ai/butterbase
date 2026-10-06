# Docs screenshot capture list

Screenshot slots are marked in the content as `<!-- SCREENSHOT: <file>.png -->`. They are
invisible in the published page, so the docs read as finished while the shots are
outstanding. The table below is the source of truth for what each one shows.

## How to land one

1. Capture the shot described in the table below.
2. Save it to `public/img/templates/<file>.png`.
3. Replace the `<!-- SCREENSHOT: <file>.png -->` line with:
   `![<alt text>](/img/templates/<file>.png)`
4. `npm run build` and check the page.

Find every outstanding slot with:

```bash
grep -rn "SCREENSHOT:" src/content/docs/
```

## Conventions

- **Viewport:** 1440×900, light theme (the docs site defaults light; dark shots read as
  inconsistent next to the rest of the page).
- **Format:** PNG (UI screenshots stay crisp; JPEG artifacts around text look bad). Aim under
  ~500 KB per file. Do **not** reach for `sips -Z` to shrink one — it re-encodes without
  optimisation and can make the file *larger* while losing resolution. Use `pngquant` or
  `optipng` if you have them; neither is installed on this machine, so files are committed
  as captured.
- **Crop:** to the relevant panel, not the whole browser chrome. No OS window frame.
- **Redact before committing** — these pages are public:
  - real organisation names and member emails
  - other apps in the account's app list / switcher
  - any `bb_sk_*`, `wsec_*`, or client secret, even partially
  - real customer records in CRM or Support screenshots — use seeded demo data
- **Prefer a throwaway clone** as the subject rather than a live production app.

## Captured

`templates-browser` · `clone-progress` · `crm-clone-modal` · `support-clone-env-step` ·
`support-do-env` · `crm-overview` · `support-overview` — 7 of 11.

Dropped as redundant: `templates-browser-search` and `clone-modal-name-region`. The shots
above already contain the search box, sort control, name field and region selector.

Not captured: `clone-warnings` — **there is no dashboard UI for clone warnings at all**, so
this slot cannot be filled from the dashboard. `crm-oauth-config` — capturable, but shows an
empty OAuth page unless real Google credentials are configured on the clone.

## Outstanding shots

| File | Page | Where to capture | Shows |
|---|---|---|---|
| `templates-browser.png` | `templates/available.md` | Dashboard → Templates | The grid with both template cards. **No clone counts** — the cards deliberately don't show `fork_count`. Crop above the top bar to keep the org name and account email out. |
| `templates-browser-search.png` | `templates/cloning.md` | Dashboard → Templates | Search box + Recent/Popular sort control |
| `clone-modal-name-region.png` | `templates/cloning.md` | Templates → any template → Clone | Name + region fields |
| `clone-progress.png` | `templates/cloning.md` | Clone modal after Start clone | Live status moving through replay stages |
| `clone-warnings.png` | `templates/cloning.md` | A completed clone with warnings | The warnings panel |
| `crm-overview.png` | `templates/butterbase-crm.md` | A **cloned** CRM's frontend → Companies | Companies list. Sign-in leads to a "Create your workspace" step first. Seed data does carry here (dedup fixtures — `Faceb00k`, Baidu variants), so it shoots populated. Switch to **light theme** first; the app defaults to dark. |
| `crm-clone-modal.png` | `templates/butterbase-crm.md` | Templates → butterbase-crm → Clone | Modal showing **"Nothing to enter"** and `BUTTERBASE_API_KEY` marked *Platform-provided* |
| `crm-oauth-config.png` | `templates/butterbase-crm.md` | Cloned app → Auth → Config | Google provider configured |
| `support-overview.png` | `templates/butter-support.md` | A **cloned** Support frontend → Autonomy | The autonomy dial. **Not the Inbox** — a fresh clone's inbox is empty (no seed tickets), so it shoots as a blank state. Autonomy is config-driven and carries across, so it has real content and shows the template's distinctive feature. |
| `support-clone-env-step.png` | `templates/butter-support.md` | Templates → butter-support → Clone → env step | The two `user_required` inputs beside the auto-filled keys |
| `support-do-env.png` | `templates/butter-support.md` | Cloned app → Durable Objects → class → Environment | The six re-set keys |

`crm-clone-modal.png` and `support-clone-env-step.png` are the highest-value pair: side by
side they show the difference between a template that needs nothing ("Nothing to enter")
and one that asks for `SUBSTRATE_OUTBOX_SECRET` and `RAG_COLLECTION`, which is the point
the Templates section is making.

**Both are blocked on the cross-region clone fix** — the modal's Region field is changing
from a disabled input to a working picker, so shots taken before that ships are stale.
