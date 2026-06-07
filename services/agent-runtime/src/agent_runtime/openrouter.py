"""Minimal OpenRouter chat completion client."""

from typing import Any
import httpx


class OpenRouterError(Exception):
    pass


class OpenRouterClient:
    def __init__(self, api_key: str, base_url: str = "https://openrouter.ai/api/v1"):
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
            headers={
                "Authorization": f"Bearer {api_key}",
                "HTTP-Referer": "https://butterbase.dev",
                "X-Title": "Butterbase agent-runtime",
            },
        )

    async def chat_completion(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": model, "messages": messages}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        response = await self._client.post("/chat/completions", json=payload)
        if response.status_code >= 400:
            raise OpenRouterError(
                f"OpenRouter error {response.status_code}: {response.text}"
            )
        body = response.json()
        try:
            choice = body["choices"][0]
        except (KeyError, IndexError) as exc:
            raise OpenRouterError(f"unexpected response shape: {body}") from exc
        return {
            "message": choice["message"],
            "finish_reason": choice.get("finish_reason"),
            "usage": body.get("usage", {}) or {},
        }

    async def chat_text(
        self,
        *,
        model: str,
        system: str,
        user: str,
        **kwargs: Any,
    ) -> tuple[str, dict[str, Any]]:
        """Backward-compat wrapper around chat_completion for text-only calls."""
        out = await self.chat_completion(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            **kwargs,
        )
        return out["message"]["content"] or "", out["usage"]

    async def close(self) -> None:
        await self._client.aclose()
