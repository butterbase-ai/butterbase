# Local dev container: serves the static frontend worker via Miniflare so devs
# can reproduce SPA routing locally without redeploying to butterbase. Wired up
# as the `miniflare-frontend` service in the wrapper's docker-compose.local.yml.
#
# Build context: wrapper repo root.
#   docker build -f submodules/butterbase-oss/packages/static-frontend-worker/Dockerfile .
#
# Runtime env (see scripts/local-server.mjs for the full list):
#   LOCAL_FRONTEND_ASSETS_DIR  path inside the container (mount your dist/ here)
#   LOCAL_FRONTEND_PORT        default 8787
#   LOCAL_FRONTEND_HTML_HANDLING  default auto-trailing-slash

# ---------- Builder: compile the worker against the full workspace ----------
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY submodules/butterbase-oss/package.json submodules/butterbase-oss/tsconfig.base.json submodules/butterbase-oss/
COPY submodules/butterbase-oss/packages/shared/package.json submodules/butterbase-oss/packages/shared/
COPY submodules/butterbase-oss/packages/static-frontend-worker/package.json submodules/butterbase-oss/packages/static-frontend-worker/
COPY submodules/butterbase-oss/services/mcp-server/package.json submodules/butterbase-oss/services/mcp-server/
COPY submodules/butterbase-oss/services/control-api/package.json submodules/butterbase-oss/services/control-api/

RUN npm ci

COPY submodules/butterbase-oss/packages/static-frontend-worker/ submodules/butterbase-oss/packages/static-frontend-worker/

# --force defeats stale tsbuildinfo from the host (.dockerignore strips dist
# but not tsbuildinfo). Build also runs scripts/emit-source.mjs which writes
# dist/worker-source.generated.js.
RUN npm run build --workspace=@butterbase/static-frontend-worker

# ---------- Runtime: minimal image with miniflare + the built worker ----------
# We deliberately do NOT carry the wrapper's lockfile into this stage. The
# wrapper lockfile pins a platform-specific workerd binary (whatever the
# developer's host is), which is wrong for a linux/amd64|arm64 container.
# Installing miniflare directly here lets npm pick the right platform variant
# at install time.
#
# Runtime is debian-based, NOT alpine — Cloudflare's workerd binary is linked
# against glibc and crashes with "symbol not found" relocations on musl.
FROM node:22-slim
WORKDIR /app

# Match the devDep version from the package's package.json. Hardcoded here
# instead of read-from-package because we don't carry the workspace into
# this stage. Bump in lockstep with packages/static-frontend-worker/package.json.
#
# --include=optional is REQUIRED: workerd ships its platform-specific binary
# (@cloudflare/workerd-linux-{amd64,arm64}) as an optionalDependency, and
# recent npm versions drop optional deps when --omit=dev is set alone, which
# makes the container crash at runtime with "The package
# @cloudflare/workerd-linux-arm64 could not be found."
#
# Do NOT pipe npm through `| tail -N` here without also setting pipefail —
# an earlier version of this line piped through `| tail -5` and silently
# swallowed npm's non-zero exit, producing an image missing the workerd
# binary. node:22-slim's /bin/sh is dash and doesn't support pipefail, so
# we just let npm output land in the build log in full.
RUN npm init -y >/dev/null && \
    npm install --omit=dev --include=optional --no-package-lock miniflare@^4.20260426.0

COPY --from=builder /app/submodules/butterbase-oss/packages/static-frontend-worker/dist ./dist/
COPY --from=builder /app/submodules/butterbase-oss/packages/static-frontend-worker/scripts ./scripts/
COPY --from=builder /app/submodules/butterbase-oss/packages/static-frontend-worker/local-assets ./local-assets/

ENV LOCAL_FRONTEND_HOST=0.0.0.0
ENV LOCAL_FRONTEND_PORT=8787

EXPOSE 8787

CMD ["node", "./scripts/local-server.mjs"]
