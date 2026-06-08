"""Thin client for calling /internal/agent-tools/* on control-api.

control-api is a known internal service at a known address — SSRF
guarding (safe_request) is for *third-party* outbound (MCP servers,
webhooks) and would just be a footgun here. This client uses a plain
httpx client and the shared INTERNAL_SERVICE_TOKEN.
"""

from typing import Any
import httpx


class ControlApiClient:
    def __init__(self, *, base_url: str, token: str):
        self._base = base_url.rstrip("/")
        self._token = token
        self._client = httpx.AsyncClient(timeout=30.0)

    async def call_builtin(
        self,
        *,
        tool_name: str,
        app_id: str,
        run_id: str,
        caller_kind: str,
        caller_user_id: str | None,
        args: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._post(
            f"/internal/agent-tools/builtin/{tool_name}",
            {"app_id": app_id, "run_id": run_id,
             "caller_kind": caller_kind, "caller_user_id": caller_user_id,
             "args": args},
        )

    async def invoke_function(
        self,
        *,
        function_name: str,
        app_id: str,
        run_id: str,
        caller_kind: str,
        caller_user_id: str | None,
        args: dict[str, Any],
    ) -> dict[str, Any]:
        return await self._post(
            "/internal/agent-tools/function-invoke",
            {"function_name": function_name, "app_id": app_id, "run_id": run_id,
             "caller_kind": caller_kind, "caller_user_id": caller_user_id,
             "args": args},
        )

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base}{path}"
        headers = {"x-internal-service-token": self._token,
                   "content-type": "application/json"}
        resp = await self._client.post(url, headers=headers, json=body)
        if resp.status_code >= 500:
            raise RuntimeError(f"control-api {resp.status_code}: {resp.text}")
        return resp.json()

    async def close(self) -> None:
        await self._client.aclose()
