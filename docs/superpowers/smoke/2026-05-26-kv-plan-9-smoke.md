# KV Plan 9 — Smoke Notes

## What landed
- 984f5b8 docs(kv): core-concepts/kv.md + sidebar entry (175 lines)
- 134e2b0 docs(kv): api-reference/kv-api.md (577 lines, 17 endpoints)
- 9a79131 docs(kv): guides/kv-recipes.md (194 lines, 5 recipes)
- f22cd03 docs(kv): CLI/SDK/MCP-tools surface docs append (3 files, +130 lines)

## Build

```
[Building search indexes]
Total:
  Indexed 1 language
  Indexed 43 pages
  Indexed 4113 words
  Indexed 0 filters
  Indexed 0 sorts

Finished in 0.136 seconds
09:36:50 [WARN] [@astrojs/sitemap] The Sitemap integration requires the `site` astro.config option. Skipping.
09:36:50 [build] 46 page(s) built in 4.18s
09:36:50 [build] Complete!
```

46 pages built clean. One pre-existing WARN: sitemap integration requires `site` config option — not introduced by Plan 9.

## HTTP probe (local preview)

```
core-concepts/kv: HTTP 200
api-reference/kv-api: HTTP 200
guides/kv-recipes: HTTP 200
```

CLI page KV mentions:
```
KV
KV
KV
```

MCP-tools page manage_kv mention:
```
manage_kv
```

All three new pages return 200. CLI page renders KV section. MCP-tools page renders manage_kv tool entry.

## Forbidden-terms grep

```
$ grep -rEn "hash tag|\{app_|_meta:|notify-keyspace|KV_REDIS_URL|KV_GATEWAY|BUTTERBASE_INTERNAL|cluster topology|noeviction|appendonly|appendfsync" \
  core-concepts/kv.md \
  api-reference/kv-api.md \
  guides/kv-recipes.md \
  sdks-and-tools/cli.md \
  sdks-and-tools/typescript-sdk.md \
  api-reference/mcp-tools.md

api-reference/kv-api.md:13:https://api.butterbase.ai/v1/{app_id}/kv/...
api-reference/kv-api.md:16:Replace `{app_id}` with your app's ID (e.g. `app_abc123`). The `kv/` prefix is fixed; everything after it is either a user key or one of the reserved `_`-prefixed paths described below.
```

**Judgment:** The two hits on `{app_id}` are a standard REST URL template placeholder in the Base URL section — customer-facing documentation that tells developers to substitute their app ID. This is not an internal env var, leaked secret, or implementation detail. It is the correct public-facing URL shape. No fix required.

All other forbidden terms: no matches.

Redis check:
```
$ grep -rn "Redis\|redis://" core-concepts/kv.md api-reference/kv-api.md guides/kv-recipes.md
(no output)
```

Clean — no Redis mentions in the three new KV docs.

## llms.txt regeneration
- public/llms.txt and public/llms-full.txt are build artifacts (in .gitignore).
- Generator (Astro integration at services/docs/src/integrations/llms-generator.ts) runs on every build.
- Verified: build output includes "[llms-generator] Generated llms-full.txt (42 sections) and llms.txt".
- Preview server also confirmed regeneration on startup:
  ```
  09:36:16 [llms-generator] Generating llms.txt and llms-full.txt…
  09:36:16 [llms-generator] Generated llms-full.txt (42 sections) and llms.txt
  ```
- KV pages confirmed in llms.txt output:
  - https://docs.butterbase.ai/core-concepts/kv/
  - https://docs.butterbase.ai/guides/kv-recipes/
  - https://docs.butterbase.ai/api-reference/kv-api/

## Open items
- The `{app_id}` URL template in api-reference/kv-api.md triggers the forbidden-terms grep pattern `\{app_` — this is a false positive (legitimate customer-facing URL template); the grep pattern could be tightened in future to exclude known-safe URL path params.
- Sitemap integration WARN is pre-existing (no `site` config in astro.config); not a Plan 9 regression.
