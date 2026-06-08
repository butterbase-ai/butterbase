"""Tests for OpenRouterClient using httpx.MockTransport (no external dependencies)."""

import json

import httpx
import pytest

from agent_runtime.openrouter import OpenRouterClient, OpenRouterError


def _make_client(response_body: dict, status_code: int = 200) -> OpenRouterClient:
    """Create an OpenRouterClient backed by a MockTransport returning a fixed response."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status_code, json=response_body)

    client = OpenRouterClient.__new__(OpenRouterClient)
    client._client = httpx.AsyncClient(
        base_url="https://openrouter.ai/api/v1",
        transport=httpx.MockTransport(handler),
        headers={
            "Authorization": "Bearer sk-test",
            "HTTP-Referer": "https://butterbase.dev",
            "X-Title": "Butterbase agent-runtime",
        },
    )
    return client


# ---------------------------------------------------------------------------
# chat_text (backward-compat wrapper)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chat_text_returns_text_and_usage():
    client = _make_client({
        "choices": [{"message": {"role": "assistant", "content": "hi there"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
    })
    text, usage = await client.chat_text(
        model="anthropic/claude-3.5-sonnet",
        system="You are helpful.",
        user="hello",
    )
    assert text == "hi there"
    assert usage["prompt_tokens"] == 5
    await client.close()


@pytest.mark.asyncio
async def test_chat_text_raises_on_error():
    client = _make_client({"error": "boom"}, status_code=500)
    with pytest.raises(OpenRouterError):
        await client.chat_text(model="x", system="s", user="u")
    await client.close()


# ---------------------------------------------------------------------------
# chat_completion — text response
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chat_completion_returns_message_dict():
    client = _make_client({
        "choices": [{"message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 4, "completion_tokens": 3},
    })
    result = await client.chat_completion(
        model="x",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert result["message"]["content"] == "hello"
    assert result["finish_reason"] == "stop"
    assert result["usage"]["prompt_tokens"] == 4
    await client.close()


# ---------------------------------------------------------------------------
# chat_completion — tool_calls response (via httpx.MockTransport)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_chat_completion_returns_tool_calls():
    tool_calls_body = {
        "choices": [{
            "message": {
                "role": "assistant",
                "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "my_tool", "arguments": json.dumps({"x": 1})},
                }],
            },
            "finish_reason": "tool_calls",
        }],
        "usage": {"prompt_tokens": 7, "completion_tokens": 5},
    }
    client = _make_client(tool_calls_body)
    tools = [{"type": "function", "function": {"name": "my_tool", "description": "", "parameters": {}}}]
    result = await client.chat_completion(
        model="x",
        messages=[{"role": "user", "content": "do something"}],
        tools=tools,
    )
    assert result["finish_reason"] == "tool_calls"
    tc = result["message"]["tool_calls"]
    assert len(tc) == 1
    assert tc[0]["function"]["name"] == "my_tool"
    assert json.loads(tc[0]["function"]["arguments"]) == {"x": 1}
    await client.close()


@pytest.mark.asyncio
async def test_chat_completion_raises_on_bad_shape():
    client = _make_client({"choices": []})
    with pytest.raises(OpenRouterError, match="unexpected response shape"):
        await client.chat_completion(model="x", messages=[{"role": "user", "content": "hi"}])
    await client.close()
