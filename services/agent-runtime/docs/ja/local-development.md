# ローカル開発

[日本語README](../../README.ja.md)

## インストール

Python 3.12の仮想環境を作ります。

```bash
cd services/agent-runtime
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

## 環境変数

Postgres・OpenRouter・MCP復号キー・内部サービス認証・callback先・Redisを設定します。例中の`<...>`は自分の値へ置き換えるプレースホルダーです。`AUTH_ENCRYPTION_KEY`はcontrol-apiと同じ64桁のhexキーにします。

```bash
# Postgres connection string (single-region fallback; or set BUTTERBASE_REGIONS
# + RUNTIME_DB_URL_<REGION>, or RUNTIME_DB_URL)
CONTROL_PLANE_URL=postgres://postgres:postgres@localhost:5432/butterbase_control

# OpenRouter credentials
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_BASE_URL=          # optional; override to point at a local mock

# 64 hex-char key — MUST match the value used by control-api.
# Without this, MCP auth-header decryption throws a confusing AESGCM error.
AUTH_ENCRYPTION_KEY=<64-hex-chars>

# Shared secret between control-api and agent-runtime
INTERNAL_SERVICE_TOKEN=<token>

# Base URL of control-api for callbacks (default http://control-api:4000)
CONTROL_API_URL=http://localhost:3000

# Redis for run events (default redis://redis:6379)
REDIS_URL=redis://localhost:6379
```

## 起動

```bash
CONTROL_PLANE_URL=postgres://postgres:postgres@localhost:5432/butterbase_control \
OPENROUTER_API_KEY=sk-or-... \
AUTH_ENCRYPTION_KEY=<64-hex-chars> \
INTERNAL_SERVICE_TOKEN=<token> \
CONTROL_API_URL=http://localhost:3000 \
uvicorn agent_runtime.app:app --reload --port 7140
```

## OpenRouterのmock

`OPENROUTER_BASE_URL`をローカルmockへ向け、`OPENROUTER_API_KEY`に空でない文字列を指定します。標準ライブラリだけで動く`tests/live/fake_openrouter.py`は、`python tests/live/fake_openrouter.py [PORT]`で別途起動します。既定ポートは7141です。

```bash
OPENROUTER_BASE_URL=http://localhost:7141 \
OPENROUTER_API_KEY=fake \
uvicorn agent_runtime.app:app --reload --port 7140
```

`tests/live/e2e_*.py`もmockが別プロセスで動いていることを前提とし、CIでは実行しません。

## テスト

```bash
pytest
```

`tests/`直下のunitはcompiler・spec・tool source・暗号・event・checkpoint・HTTP routeを確認します。`tests/live/`のe2eには実行中のstackと`fake_control_api.py`・`fake_mcp_server.py`・`fake_openrouter.py`などが必要です。
