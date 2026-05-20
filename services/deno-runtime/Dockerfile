FROM denoland/deno:alpine

RUN apk add --no-cache curl

WORKDIR /app

# Copy all runtime source files
COPY *.ts ./

# Cache dependencies
RUN deno cache server.ts

EXPOSE 7133

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--unstable-worker-options", "server.ts"]
