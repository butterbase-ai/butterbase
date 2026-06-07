"""Stdlib fake OpenRouter server. Echoes the user message back as content.

Supports tool-call directives in the latest user message:
  CALL_TOOL:<tool_name>:<json_args>   → returns a single tool_calls response
  CALL_TOOLS:<json_array>             → returns multiple parallel tool_calls
  role=tool messages                  → returns "done: ok"

Run: python services/agent-runtime/tests/live/fake_openrouter.py [PORT]
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_CALL_TOOL_RE = re.compile(r"^CALL_TOOL:(\w+):(.+)$", re.DOTALL)
_CALL_TOOLS_RE = re.compile(r"^CALL_TOOLS:(\[.+\])$", re.DOTALL)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/chat/completions":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        messages = body.get("messages", [])
        tools = body.get("tools")

        # Find the latest message
        last_msg = messages[-1] if messages else {}
        last_role = last_msg.get("role", "")
        last_content = last_msg.get("content", "") or ""

        payload: dict

        if tools and last_role == "tool":
            # Return final text after tool result
            tool_result = last_content
            payload = {
                "id": "fake-1",
                "choices": [{
                    "message": {"role": "assistant", "content": f"done: {tool_result}"},
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
            }
        elif tools:
            # Check for CALL_TOOL directive in latest user message
            user_msg = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    user_msg = m.get("content", "") or ""
                    break
            stripped = user_msg.strip()
            mt = _CALL_TOOL_RE.match(stripped)
            ms = _CALL_TOOLS_RE.match(stripped)
            if mt:
                tool_name = mt.group(1)
                json_args = mt.group(2)
                payload = {
                    "id": "fake-1",
                    "choices": [{
                        "message": {
                            "role": "assistant",
                            "tool_calls": [{
                                "id": "c1",
                                "type": "function",
                                "function": {"name": tool_name, "arguments": json_args},
                            }],
                        },
                        "finish_reason": "tool_calls",
                    }],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
                }
            elif ms:
                calls = json.loads(ms.group(1))
                tool_calls = [
                    {
                        "id": f"c{i}",
                        "type": "function",
                        "function": {
                            "name": c["name"],
                            "arguments": json.dumps(c.get("arguments", {})),
                        },
                    }
                    for i, c in enumerate(calls)
                ]
                payload = {
                    "id": "fake-1",
                    "choices": [{
                        "message": {"role": "assistant", "tool_calls": tool_calls},
                        "finish_reason": "tool_calls",
                    }],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
                }
            else:
                # No directive — echo back
                reply = f"echoed: {user_msg}"
                payload = {
                    "id": "fake-1",
                    "choices": [{"message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
                }
        else:
            # No tools — echo user message
            user_msg = ""
            for m in messages:
                if m.get("role") == "user":
                    user_msg = m.get("content", "")
            reply = f"echoed: {user_msg}"
            payload = {
                "id": "fake-1",
                "choices": [{"message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 5, "total_tokens": 12},
            }

        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("fake-openrouter: " + fmt % args + "\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7141
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"fake-openrouter listening on :{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
