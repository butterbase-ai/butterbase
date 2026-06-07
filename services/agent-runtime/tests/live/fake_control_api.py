"""Fake control-api for agent-runtime live tests.

Handles the two internal routes that agent-runtime calls for tool dispatch:
  POST /internal/agent-tools/builtin/auth_user_lookup  → {"ok": true, "result": {"users": []}}
  POST /internal/agent-tools/function-invoke           → {"ok": true, "result": {"summary": "ok"}}

All other builtin routes also return a generic ok response so the driver is
not fragile to builtin-name changes.

Run:
    python services/agent-runtime/tests/live/fake_control_api.py [PORT]

Default port: 4001.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")

        if self.path.startswith("/internal/agent-tools/builtin/"):
            tool_name = self.path.split("/")[-1]
            if tool_name == "auth_user_lookup":
                result = {"users": []}
            else:
                result = {"ok": True}
            payload = {"ok": True, "result": result}
        elif self.path == "/internal/agent-tools/function-invoke":
            fn = body.get("function_name", "")
            payload = {"ok": True, "result": {"summary": "ok", "function": fn}}
        else:
            self.send_response(404)
            self.end_headers()
            return

        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("fake-control-api: " + fmt % args + "\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4001
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"fake-control-api listening on :{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
