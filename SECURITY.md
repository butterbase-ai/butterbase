# Security Policy

## Reporting a vulnerability

Please report security issues privately to **security@butterbase.ai**. We aim to acknowledge within two business days.

Please do not file public GitHub issues for security vulnerabilities.

When reporting, include:

- Affected component and version (commit SHA if applicable)
- Reproduction steps
- Impact assessment if you have one

We will work with you on a coordinated disclosure timeline before any public discussion.

## Supported versions

The latest tagged release on `main` receives security updates. We do not currently backport fixes to older minor versions.

## Operational notes for self-hosters

- **`BUTTERBASE_E2E=1` is a test-only auth bypass.** The control-api refuses to start when this is set alongside `NODE_ENV=production`, but the bypass mechanism is visible in the source. Never set this variable on any internet-reachable host.
- The default control-api configuration accepts unauthenticated requests on internal endpoints intended for in-cluster service-to-service traffic. Make sure those ports are not exposed publicly. See `SETUP.md`.
- Storage signed URLs use a signing secret; rotate it if you suspect exposure.
- The AI gateway, when no upstream `RouterAdapter` is registered, returns errors rather than calling external providers. Wire your own adapter (with your own API keys) before pointing real traffic at it.

## App database RLS trust boundary

App databases are isolated per app. Inside one app database, end-user and
anonymous row access on **RLS-enabled tables** is enforced by PostgreSQL
policies after trusted server code resolves the app and authentication context. Platform credentials must
pass the app ownership / organization checks before using the service role.
Tables with RLS disabled have no row isolation; enable RLS and define policies
for data that must be scoped to users.

The database connection role is privileged (`BYPASSRLS` on Neon). Direct SQL
on that connection can bypass row policies. This is an intentional **fail-open
connection model**, not a database guarantee that every server query is scoped.
Keep connection credentials server-side and treat code that obtains an app
pool as trusted. A missing role wrapper is a security regression.

Customer-data queries in Auto API, RAG and database agent builtins use the
shared `executeWithRole` helper. It starts a transaction, selects
`butterbase_anon`, `butterbase_user` or `butterbase_service`, and sets the policy
context with `SET LOCAL` before running customer SQL. The transaction resets
that context before the client returns to the pool. Setup or query failures
roll back and release the client.

`butterbase_service` is a non-`BYPASSRLS` role with explicitly permissive app
policies; platform credentials and authorized backend operations intentionally
have full app access. Schema introspection, migrations, policy DDL and RAG
collection-configuration lookups use trusted administrative access. RAG
ingestion writes use the service role and retain the resolved user attribution;
RAG document/chunk reads and user deletes use the caller's role. Realtime has
its own transaction-scoped role setup. These paths must be reviewed separately
when changing authorization; the shared helper is not a blanket SQL firewall.

Regression coverage in `rls-boundary.test.ts` exercises all 19 shared-helper
call sites present in this change (5 Auto API, 9 RAG, 5 database agent builtins)
and rejects customer SQL issued without an established role transaction.
`rls-context.test.ts` checks setup failures and rollback. To verify actual
PostgreSQL policy enforcement, use an **isolated disposable** PostgreSQL
instance and run:

```sh
RLS_TEST_PG_URL=postgresql://fixture:fixture_only@127.0.0.1:55432/postgres \
npm run test:integration --workspace=services/control-api -- src/services/rls-context.integration.test.ts
```

The example credentials are fixture-only. This suite creates a temporary
database, applies the RLS helper/role migrations, checks two-user and anonymous
isolation, authorized service access, cross-user write rejection and pooled
context cleanup, then removes its fixtures. It creates cluster-wide roles
when missing, so do not point it at a shared or production database. Without
`RLS_TEST_PG_URL`, this optional suite is skipped. It does not replace testing
the authentication plugin, every route family, or the deployment boundary.
