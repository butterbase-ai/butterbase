# services/build-runner/container/Dockerfile
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Non-root build user. CF further isolates instances; this is defense-in-depth.
RUN useradd -m -u 1001 build
USER build
WORKDIR /home/build

COPY --chown=build:build package.json ./
RUN npm install --omit=dev

COPY --chown=build:build entry.mjs r2.mjs ./

ENV NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["node", "/home/build/entry.mjs"]
