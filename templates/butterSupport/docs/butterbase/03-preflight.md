# Preflight — 2026-06-18

- account         ✓  list_regions succeeded; account active
- mcp_connected   ✓  Butterbase MCP tools available throughout planning
- api_key         ✓  Account-scoped service key generated via manage_auth_config. Name `kenneth-dev-shell`, prefix `bb_sk_3ae1c6`, substrate_access=true, key_id `2cdb8ca3-e228-44d6-bc9d-32f051107c3d`. User instructed to `export BUTTERBASE_API_KEY=…` in `~/.zshrc`. Raw key value not stored in this artifact (shown once at creation).
- cli             ✓  `butterbase --version` → 0.5.0
- app_provisioned ✓  app_id=app_0ycj4ad7odud  region=us-east-1  subdomain=butter-support  api_base=https://api.butterbase.ai/v1/app_0ycj4ad7odud  url=https://butter-support.butterbase.dev
- substrate_linked ✓ substrate_user_id=249d87fa-a4a9-4456-b647-f05221472bc8 (same as CRM app_44zjayftl7b3 — shared entity graph as planned)
- access_mode      ✓ public (will tighten to authenticated during journey-auth via `manage_app secure`)
- cors             — defaults to `http://localhost:3000`; widened to recipe subdomain + permissive `/widget/*` during journey-frontend deploy
- visibility       — private (will flip to public during journey-templates after successful deploy + smoke)

Re-run with /butterbase-skills:journey-preflight.
