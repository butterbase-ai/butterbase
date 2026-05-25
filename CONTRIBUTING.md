# Contributing

Thanks for your interest in Butterbase! This document covers how to set up a dev environment, the scope of what belongs in this repo vs. the managed offering, and the PR workflow.

## Code of conduct

Be respectful. Disagree on substance, not on people. We follow the spirit of the Contributor Covenant.

## Scope: what belongs here

The OSS repo is the **runtime data plane**. PRs are welcome for:

- Control-API features (auth, storage, functions, RLS, migrations, AI gateway plumbing)
- MCP server tools
- Runtime improvements (`agent-runtime`, `deno-runtime`, `build-runner`)
- SDK/CLI/plugin DX
- Self-hoster docs, examples, runbooks
- Bug fixes, perf wins, security hardening

What **does not** belong here (it lives in our private cloud repo):

- Billing integrations (Stripe, etc.). The `BillingProvider` interface in `packages/shared` is the seam — self-hosters can wire their own provider; we wire ours.
- Lease-based quota enforcement math. The `QuotaEnforcer` interface is the seam.
- Upstream AI router adapters with specific provider credentials. The `RouterAdapter` interface is the seam.
- Multi-region orchestration (region routing, app moves between regions).
- Managed-service admin dashboards.

If you have an idea that touches the boundary, please open an issue first to talk about whether it should land here, in a separate plugin, or stay private.

## Dev setup

Requirements: Docker, Node 22+, npm. Full walkthrough: [`SETUP.md`](./SETUP.md).

```bash
git clone --recurse-submodules https://github.com/NetGPT-Inc/butterbase-oss.git
cd butterbase-oss
git submodule update --init --recursive   # if plugin/ is empty
npm ci
cp .env.example .env
docker compose -f docker-compose.local.yml up -d

export NEON_PLATFORM_PRIMARY_URL=postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control
export NEON_RUNTIME_PROJECT_ID_US_EAST_1=postgresql://butterbase:butterbase_dev@localhost:5437/butterbase_runtime_us
export BUTTERBASE_REGIONS=us-east-1
npm run migrate:all
npm run seed:dev

curl -sf http://localhost:4000/health/ready
```

The repo is an npm workspaces monorepo. Per-workspace commands:

```bash
npm run build --workspace=services/control-api
npm test --workspace=@butterbase/shared
npm test --workspace=services/control-api
```

## Running tests

- **Unit tests:** per workspace (`npm test --workspace=...`); there is no root `npm test`
- **E2E tests:** `npm run e2e:all` (requires the docker-compose stack running)

Tests that hit the network or an external service are skipped unless their env vars are set; see individual test files.

## PR process

1. Open an issue first for any non-trivial change to discuss the approach.
2. Fork, branch from `main`. Branch name format: `feat/<short-desc>` or `fix/<short-desc>`.
3. Keep PRs focused. One concern per PR.
4. Add tests. Coverage matters most around RLS, auth, and the AI gateway request path.
5. Commit messages: imperative mood, scoped prefix when useful (`feat(control-api):`, `fix(mcp):`). One blank line, then a body explaining *why* if non-obvious.
6. Run `npm run typecheck` (where defined) and workspace tests before pushing.
7. Open a PR against `main`. Fill in the PR template.

## Coding style

- TypeScript everywhere except for shell scripts and the Cloudflare Workers (`dispatch-worker`, `bb-placeholder`).
- ESM modules (`"type": "module"` in package.json).
- Prettier is the formatter; ESLint catches obvious bugs. Both run in CI.
- Prefer composition over inheritance, named exports over default exports.

## Security

Do not file security issues in public. See [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree your code will be released under the Apache-2.0 license (see [`LICENSE`](./LICENSE)).
