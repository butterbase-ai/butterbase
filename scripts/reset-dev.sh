#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Stopping all containers and removing volumes"
docker compose down -v

echo "==> Done. Run 'make dev' or './scripts/dev-setup.sh' to start fresh."
