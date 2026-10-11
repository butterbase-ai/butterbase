# Local move-app smoke test

Issue #42: `BUTTERBASE_LOCAL=true` provisions destination customer databases
with PostgreSQL directly, without calling the Neon Management API. The normal
Neon path is unchanged when the flag is absent. Local mode rejects production.

Set `LOCAL_DATA_PLANE_URL_<REGION>` to an **admin connection URL** for each
local destination region (uppercase, hyphens replaced by underscores). The
role must be allowed to create/drop databases. Use disposable development
clusters only. Customer databases use the existing `cust_<appId>_<region>`
naming convention. Their connection rows are stored in the destination runtime
DB with no Neon project ID. Retries adopt an existing database; abort removes it.
A URI `dbname` query override is removed from the customer connection URL so
Node and libpq both connect to the destination database.

## Run the self-contained smoke

Requirements: Node 22+, npm, Docker, and PostgreSQL `pg_dump` and `psql` on PATH.
Use matching PostgreSQL client/server versions. No cloud credentials are needed.

```sh
npm ci
npm run build --workspace=@butterbase/shared

# These credentials are disposable test fixtures, not deployment defaults.
docker run -d --name bb-move-smoke-pg \
  -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=butterbase_fixture -e POSTGRES_PASSWORD=fixture_only \
  --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:16

docker run -d --name bb-move-smoke-redis-source \
  -p 127.0.0.1:56379:6379 redis:7-alpine redis-server --save '' --appendonly no

docker run -d --name bb-move-smoke-redis-dest \
  -p 127.0.0.1:56380:6379 redis:7-alpine redis-server --save '' --appendonly no

# Wait until PostgreSQL and both Redis servers are ready, then run:
LOCAL_MOVE_SMOKE_PG_URL=postgresql://butterbase_fixture:fixture_only@127.0.0.1:55432/postgres \
LOCAL_MOVE_SMOKE_REDIS_SOURCE_URL=redis://127.0.0.1:56379 \
LOCAL_MOVE_SMOKE_REDIS_DEST_URL=redis://127.0.0.1:56380 \
npm test --workspace=services/control-api -- src/services/move-app/local-move-smoke.test.ts

# Remove only these disposable fixtures after testing.
docker rm -f bb-move-smoke-pg bb-move-smoke-redis-source bb-move-smoke-redis-dest
```

The test creates uniquely named control/runtime/customer databases, drives
`driveOnce` with the production step registry, and checks completion, customer
rows, agent checkpoint child rows, KV contents, routing, and abort compensation.
The fixture deliberately contains only the tables needed by this regression;
it does not replace migration or full deployment tests.

Dump transport uses the existing injected upload/download seams with in-memory
buffers; the customer dump/restore still runs real `pg_dump`/`psql`. R2 blob
copying uses the existing shared-storage skip, and reverse logical replication
is not configured. No public domain or cloud scheduler is contacted. Without
all three `LOCAL_MOVE_SMOKE_*` URLs, the suite is skipped.

For an existing local multi-region environment, set `BUTTERBASE_LOCAL=true`
and a `LOCAL_DATA_PLANE_URL_<REGION>` for each destination before running the
saga. Runtime DB and KV Redis region configuration is still required; local
mode changes customer DB provisioning and compensation only.
