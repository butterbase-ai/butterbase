#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Copying .env.example to .env (if needed)"
[ -f .env ] || cp .env.example .env

echo "==> Installing dependencies"
npm install

echo "==> Building shared package"
npm run build --workspace=packages/shared

echo "==> Starting Docker infrastructure"
docker compose -f docker-compose.local.yml up -d control-plane-db data-plane-db pgbouncer traefik

echo "==> Waiting for databases to be healthy"
until docker compose exec -T control-plane-db pg_isready -U butterbase -q 2>/dev/null; do
  sleep 1
done
until docker compose exec -T data-plane-db pg_isready -U butterbase -q 2>/dev/null; do
  sleep 1
done

echo "==> Running Control Plane migrations"
npx tsx db/control-plane/migrate.ts

echo "==> Building MCP Server"
npm run build --workspace=services/mcp-server

echo "==> Building and starting Control API"
docker compose -f docker-compose.local.yml up -d --build control-api

echo "==> Waiting for Control API"
until curl -sf http://localhost:4000/health > /dev/null 2>&1; do
  sleep 1
done

echo "==> Building and starting Dashboard API and Dashboard"
docker compose -f docker-compose.local.yml up -d --build dashboard-api dashboard

echo "==> Waiting for Dashboard API"
until curl -sf http://localhost:4100/health > /dev/null 2>&1; do
  sleep 1
done

echo ""
echo "Butterbase is ready!"
echo "  Control API:    http://localhost:4000/health"
echo "  Dashboard API:  http://localhost:4100/health"
echo "  Dashboard:      http://localhost:3000"
echo "  Init:   curl -X POST http://localhost:4000/init -H 'Content-Type: application/json' -d '{\"name\":\"my-app\"}'"
