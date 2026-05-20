.PHONY: dev test reset logs clean

dev:
	./scripts/dev-setup.sh

test:
	npm test --workspace=services/control-api

reset:
	./scripts/reset-dev.sh

logs:
	docker compose logs -f

clean:
	npm run clean
	docker compose down -v
