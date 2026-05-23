# Local-dev Dockerfile for the kv-gateway Worker.
# Production deployment uses `wrangler deploy` to Cloudflare directly — this file
# is NOT used in production. It exists so docker-compose.local.yml can run the
# Worker via wrangler dev --local (which runs workerd, the real Workers runtime).

FROM node:22-slim

WORKDIR /app

# Install pnpm (matches the monorepo's package manager).
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Copy package manifests first for better layer caching.
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source.
COPY src ./src
COPY wrangler.toml tsconfig.json ./

EXPOSE 8787

# Run wrangler dev with --local (workerd-backed local runtime, no CF auth needed),
# bound to 0.0.0.0 so other docker services can reach it via the service hostname.
CMD ["pnpm", "exec", "wrangler", "dev", "--local", "--port", "8787", "--ip", "0.0.0.0"]
