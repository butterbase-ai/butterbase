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
- **Format:** PNG, 2× DPI, then compress. Keep each file under ~300 KB.
- **Crop:** to the relevant panel, not the whole browser chrome. No OS window frame.
- **Redact before committing** — these pages are public:
  - real organisation names and member emails
  - other apps in the account's app list / switcher
  - any `bb_sk_*`, `wsec_*`, or client secret, even partially
  - real customer records in CRM or Support screenshots — use seeded demo data
- **Prefer a throwaway clone** as the subject rather than a live production app.

## Outstanding shots

| File | Page | Where to capture | Shows |
|---|---|---|---|
| `templates-browser.png` | `templates/available.md` | Dashboard → Templates | The grid with both template cards, clone counts visible |
| `templates-browser-search.png` | `templates/cloning.md` | Dashboard → Templates | Search box + Recent/Popular sort control |
| `clone-modal-name-region.png` | `templates/cloning.md` | Templates → any template → Clone | Name + region fields |
| `clone-progress.png` | `templates/cloning.md` | Clone modal after Start clone | Live status moving through replay stages |
| `clone-warnings.png` | `templates/cloning.md` | A completed clone with warnings | The warnings panel |
| `crm-overview.png` | `templates/butterbase-crm.md` | Running CRM frontend | Contacts or dashboard view |
| `crm-clone-modal.png` | `templates/butterbase-crm.md` | Templates → butterbase-crm → Clone | Modal + the **empty** env-vars step |
| `crm-oauth-config.png` | `templates/butterbase-crm.md` | Cloned app → Auth → Config | Google provider configured |
| `support-overview.png` | `templates/butter-support.md` | Running Support frontend | Approval-gated reply queue |
| `support-clone-env-step.png` | `templates/butter-support.md` | Templates → butter-support → Clone → env step | The two `user_required` inputs beside the auto-filled keys |
| `support-do-env.png` | `templates/butter-support.md` | Cloned app → Durable Objects → class → Environment | The six re-set keys |

`crm-clone-modal.png` and `support-clone-env-step.png` are the highest-value pair: side by
side they show the difference between a template that needs nothing and one that needs
configuration, which is the point the Templates section is making.
