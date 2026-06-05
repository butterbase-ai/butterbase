FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/static-frontend-worker/package.json packages/static-frontend-worker/
COPY services/mcp-server/package.json services/mcp-server/
COPY services/control-api/package.json services/control-api/

# Install all workspace dependencies
RUN npm ci

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/static-frontend-worker/ packages/static-frontend-worker/
COPY services/mcp-server/ services/mcp-server/
COPY services/control-api/ services/control-api/
COPY db/ db/

# Build shared + static-frontend-worker first, then MCP + control-api
# (control-api imports WORKER_SOURCE from @butterbase/static-frontend-worker;
# the package's build script runs scripts/emit-source.mjs to generate it).
RUN npm run build --workspace=@butterbase/shared
RUN npm run build --workspace=@butterbase/static-frontend-worker
RUN npm run build --workspace=services/mcp-server
RUN npm run build --workspace=services/control-api

FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/static-frontend-worker/package.json packages/static-frontend-worker/
COPY --from=builder /app/services/mcp-server/package.json services/mcp-server/
COPY --from=builder /app/services/control-api/package.json services/control-api/

RUN npm ci --omit=dev

COPY --from=builder /app/packages/shared/dist packages/shared/dist/
COPY --from=builder /app/packages/static-frontend-worker/dist packages/static-frontend-worker/dist/
COPY --from=builder /app/services/mcp-server/dist services/mcp-server/dist/
COPY --from=builder /app/services/control-api/dist services/control-api/dist/
COPY --from=builder /app/db/ db/

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "services/control-api/dist/index.js"]
