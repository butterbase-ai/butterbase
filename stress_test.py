# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "websockets>=12.0",
# ]
# ///
"""
Butterbase Hackathon Stress Test

Simulates 200 hackathon participants, each with their own app and 10 end-users,
performing Auth, CRUD, Schema, Storage, and Realtime operations concurrently.

Usage:
    uv run stress_test.py --api-key bb_sk_... --base-url https://api.butterbase.ai

    # Quick smoke test (5 apps, 2 users each)
    uv run stress_test.py --api-key bb_sk_... --num-apps 5 --users-per-app 2

    # Run only specific phases
    uv run stress_test.py --api-key bb_sk_... --phases auth,crud
"""

import argparse
import asyncio
import json
import os
import random
import string
import sys
import time
from dataclasses import dataclass
from typing import Optional

import httpx


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class Config:
    base_url: str = "https://api.butterbase.ai"
    api_key: str = ""
    num_apps: int = 200
    users_per_app: int = 10
    batch_size_apps: int = 40
    batch_size_schema: int = 50
    batch_size_auth: int = 100
    batch_size_crud: int = 200
    batch_size_storage: int = 50
    batch_size_realtime: int = 50
    realtime_soak_seconds: int = 30
    skip_cleanup: bool = False
    phases: str = "all"
    timeout_seconds: int = 30


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

class Metrics:
    def __init__(self):
        self._data: dict[str, list[float]] = {}
        self._errors: dict[str, dict[int, int]] = {}
        self._success: dict[str, int] = {}
        self._failure: dict[str, int] = {}

    def record(self, endpoint: str, latency: float, status: int):
        if endpoint not in self._data:
            self._data[endpoint] = []
            self._errors[endpoint] = {}
            self._success[endpoint] = 0
            self._failure[endpoint] = 0

        self._data[endpoint].append(latency)
        # 101 = WebSocket upgrade success, count alongside 2xx
        if 200 <= status < 300 or status == 101:
            self._success[endpoint] += 1
        else:
            self._failure[endpoint] += 1
            self._errors[endpoint][status] = self._errors[endpoint].get(status, 0) + 1

    def report(self) -> dict:
        results = {}
        for endpoint, latencies in self._data.items():
            latencies.sort()
            n = len(latencies)
            results[endpoint] = {
                "total": n,
                "success": self._success.get(endpoint, 0),
                "failure": self._failure.get(endpoint, 0),
                "error_rate": f"{(self._failure.get(endpoint, 0) / n * 100):.1f}%" if n else "0%",
                "min_ms": f"{latencies[0] * 1000:.0f}" if n else "-",
                "max_ms": f"{latencies[-1] * 1000:.0f}" if n else "-",
                "p50_ms": f"{latencies[int(n * 0.5)] * 1000:.0f}" if n else "-",
                "p95_ms": f"{latencies[int(n * 0.95)] * 1000:.0f}" if n else "-",
                "p99_ms": f"{latencies[int(n * 0.99)] * 1000:.0f}" if n else "-",
                "errors_by_status": self._errors.get(endpoint, {}),
            }
        return results

    def print_report(self):
        results = self.report()
        if not results:
            print("\n  No metrics collected.\n")
            return

        print("\n" + "=" * 100)
        print(f"{'Endpoint':<40} {'Total':>6} {'OK':>6} {'Fail':>6} {'Err%':>6} {'p50':>7} {'p95':>7} {'p99':>7} {'Max':>7}")
        print("-" * 100)
        for endpoint, m in sorted(results.items()):
            print(
                f"{endpoint:<40} {m['total']:>6} {m['success']:>6} {m['failure']:>6} "
                f"{m['error_rate']:>6} {m['p50_ms']:>6}ms {m['p95_ms']:>6}ms "
                f"{m['p99_ms']:>6}ms {m['max_ms']:>6}ms"
            )
            if m["errors_by_status"]:
                for status, count in sorted(m["errors_by_status"].items()):
                    print(f"  {'':38} HTTP {status}: {count}")
        print("=" * 100)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def random_string(length: int = 8) -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=length))


def random_password() -> str:
    """Generate a password that meets the policy: upper, lower, digit, special, 12+ chars."""
    return f"Str0ng!{random_string(8)}#"


def make_headers(api_key: str, with_content_type: bool = True) -> dict:
    h = {"Authorization": f"Bearer {api_key}"}
    if with_content_type:
        h["Content-Type"] = "application/json"
    return h


async def timed_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    metrics: Metrics,
    endpoint_name: str,
    timeout: int = 30,
    **kwargs,
) -> tuple[int, Optional[dict]]:
    """Make an HTTP request, record metrics, return (status, body_or_none)."""
    start = time.monotonic()
    try:
        resp = await client.request(method, url, timeout=timeout, **kwargs)
        elapsed = time.monotonic() - start
        status = resp.status_code
        try:
            body = resp.json()
        except Exception:
            body = None
        metrics.record(endpoint_name, elapsed, status)
        return status, body
    except httpx.TimeoutException:
        elapsed = time.monotonic() - start
        metrics.record(endpoint_name, elapsed, 408)
        return 408, None
    except Exception as e:
        elapsed = time.monotonic() - start
        metrics.record(endpoint_name, elapsed, 0)
        print(f"  DEBUG: {method} {endpoint_name} error: {type(e).__name__}: {e}")
        return 0, None


# ---------------------------------------------------------------------------
# Phase 1: App Setup
# ---------------------------------------------------------------------------

async def phase_app_setup(client: httpx.AsyncClient, cfg: Config, metrics: Metrics) -> list[dict]:
    """Create test apps in parallel, just like a real hackathon."""
    print(f"\n[Phase 1] Creating {cfg.num_apps} apps (batch size: {cfg.batch_size_apps}, parallel)...")
    apps: list[dict] = []
    sem = asyncio.Semaphore(cfg.batch_size_apps)
    headers = make_headers(cfg.api_key)

    async def create_app(index: int):
        async with sem:
            name = f"stress-test-{random_string(6)}"
            status, body = await timed_request(
                client, "POST", f"{cfg.base_url}/init",
                metrics, "POST /init",
                timeout=cfg.timeout_seconds,  # async provisioning, returns fast
                headers=headers,
                json={"name": name},
            )
            if status == 201 and body and "app_id" in body:
                apps.append({"app_id": body["app_id"], "name": name})
            else:
                detail = ""
                if body and isinstance(body, dict):
                    detail = f" — {body.get('error', body.get('message', ''))}"
                print(f"  WARN: App #{index} failed: HTTP {status}{detail}")

    tasks = [create_app(i) for i in range(cfg.num_apps)]
    await asyncio.gather(*tasks)

    # Poll until all apps are provisioned
    if apps:
        print(f"  Waiting for {len(apps)} apps to finish provisioning...")
        pending = {a["app_id"] for a in apps}
        poll_start = time.monotonic()
        max_poll = 600  # 3 minutes max

        while pending and (time.monotonic() - poll_start) < max_poll:
            check = list(pending)
            for aid in check:
                try:
                    status, body = await timed_request(
                        client, "GET", f"{cfg.base_url}/apps/{aid}/status",
                        metrics, "GET /apps/:id/status",
                        timeout=cfg.timeout_seconds,
                        headers=headers,
                    )
                    if status == 200 and body:
                        ps = body.get("provisioning_status")
                        if ps == "ready":
                            pending.discard(aid)
                        elif ps == "failed":
                            pending.discard(aid)
                            apps[:] = [a for a in apps if a["app_id"] != aid]
                            print(f"  WARN: {aid} provisioning failed")
                except Exception:
                    pass
            if pending:
                await asyncio.sleep(2)

        elapsed = time.monotonic() - poll_start
        if pending:
            print(f"  WARN: {len(pending)} apps still provisioning after {elapsed:.0f}s")
            apps[:] = [a for a in apps if a["app_id"] not in pending]

    print(f"  Created {len(apps)}/{cfg.num_apps} apps.")
    return apps


# ---------------------------------------------------------------------------
# Phase 2: Schema Apply
# ---------------------------------------------------------------------------

STRESS_SCHEMA = {
    "tables": {
        "tasks": {
            "columns": {
                "id": {"type": "uuid", "primaryKey": True, "default": "gen_random_uuid()"},
                "title": {"type": "text"},
                "status": {"type": "text", "default": "'pending'"},
                "user_id": {"type": "uuid", "nullable": True},
                "created_at": {"type": "timestamptz", "default": "now()"},
            }
        },
        "comments": {
            "columns": {
                "id": {"type": "uuid", "primaryKey": True, "default": "gen_random_uuid()"},
                "task_id": {"type": "uuid", "references": "tasks.id"},
                "body": {"type": "text"},
                "user_id": {"type": "uuid", "nullable": True},
                "created_at": {"type": "timestamptz", "default": "now()"},
            }
        },
    }
}


async def phase_schema_apply(
    client: httpx.AsyncClient, cfg: Config, metrics: Metrics, apps: list[dict]
) -> None:
    """Apply the stress-test schema to each app."""
    print(f"\n[Phase 2] Applying schema to {len(apps)} apps (batch size: {cfg.batch_size_schema})...")
    sem = asyncio.Semaphore(cfg.batch_size_schema)
    headers = make_headers(cfg.api_key)
    ok = 0

    async def apply_schema(app_info: dict):
        nonlocal ok
        async with sem:
            status, body = await timed_request(
                client, "POST",
                f"{cfg.base_url}/v1/{app_info['app_id']}/schema/apply",
                metrics, "POST /schema/apply",
                timeout=cfg.timeout_seconds,
                headers=headers,
                json={"schema": STRESS_SCHEMA},
            )
            if 200 <= status < 300:
                ok += 1
            else:
                print(f"  WARN: Schema apply for {app_info['app_id']}: HTTP {status}")

    tasks = [apply_schema(a) for a in apps]
    await asyncio.gather(*tasks)
    print(f"  Schema applied to {ok}/{len(apps)} apps.")


# ---------------------------------------------------------------------------
# Phase 3: Auth Flood (Signup + Login)
# ---------------------------------------------------------------------------

@dataclass
class AppUser:
    app_id: str
    email: str
    password: str
    user_id: str = ""
    access_token: str = ""


async def phase_auth_flood(
    client: httpx.AsyncClient, cfg: Config, metrics: Metrics, apps: list[dict]
) -> list[AppUser]:
    """Sign up and log in end-users for each app.

    Signup is rate-limited to 5 per 15 min per app per IP.
    We batch per-app to stay within limits and retry on 429.
    """
    total_users = len(apps) * cfg.users_per_app
    print(f"\n[Phase 3] Signing up & logging in {total_users} users ({cfg.users_per_app}/app)...")

    all_users: list[AppUser] = []
    sem = asyncio.Semaphore(cfg.batch_size_auth)

    signup_ok = 0
    login_ok = 0

    async def signup_one(user: AppUser):
        nonlocal signup_ok, login_ok
        async with sem:
            # Signup — retry once on 429 after a pause
            for attempt in range(2):
                status, body = await timed_request(
                    client, "POST",
                    f"{cfg.base_url}/auth/{user.app_id}/signup",
                    metrics, "POST /auth/signup",
                    timeout=cfg.timeout_seconds,
                    json={"email": user.email, "password": user.password},
                    headers={"Content-Type": "application/json"},
                )
                if status == 429 and attempt == 0:
                    await asyncio.sleep(3)
                    continue
                break

            if status == 201 and body and "user" in body:
                user.user_id = body["user"]["id"]
                signup_ok += 1
            else:
                return  # Can't login if signup failed

            # Login
            status, body = await timed_request(
                client, "POST",
                f"{cfg.base_url}/auth/{user.app_id}/login",
                metrics, "POST /auth/login",
                timeout=cfg.timeout_seconds,
                json={"email": user.email, "password": user.password},
                headers={"Content-Type": "application/json"},
            )
            if status == 200 and body and "access_token" in body:
                user.access_token = body["access_token"]
                login_ok += 1

    # Process signups per-app sequentially, apps in parallel
    async def process_app(app_info: dict):
        app_users = []
        for j in range(cfg.users_per_app):
            u = AppUser(
                app_id=app_info["app_id"],
                email=f"user{j}-{random_string(4)}@stresstest.local",
                password=random_password(),
            )
            app_users.append(u)
            all_users.append(u)

        for u in app_users:
            await signup_one(u)

    tasks = [process_app(a) for a in apps]
    await asyncio.gather(*tasks)
    authed_users = [u for u in all_users if u.access_token]
    print(f"  Signups: {signup_ok}/{total_users}, Logins: {login_ok}/{total_users}, Authenticated: {len(authed_users)}")
    return authed_users


# ---------------------------------------------------------------------------
# Phase 4: CRUD Storm
# ---------------------------------------------------------------------------

async def phase_crud_storm(
    client: httpx.AsyncClient, cfg: Config, metrics: Metrics, users: list[AppUser]
) -> None:
    """Each user inserts a task, selects, updates, then deletes it."""
    total_ops = len(users) * 4
    print(f"\n[Phase 4] CRUD storm: {len(users)} users x 4 ops = {total_ops} requests (batch size: {cfg.batch_size_crud})...")
    sem = asyncio.Semaphore(cfg.batch_size_crud)
    ok = 0

    async def crud_cycle(user: AppUser):
        nonlocal ok
        async with sem:
            headers = make_headers(user.access_token)
            base = f"{cfg.base_url}/v1/{user.app_id}"
            # Keep api_key available from cfg closure for delete

            # INSERT
            status, body = await timed_request(
                client, "POST", f"{base}/tasks",
                metrics, "POST /v1/:app/tasks",
                timeout=cfg.timeout_seconds,
                headers=headers,
                json={
                    "title": f"Task by {user.email[:8]}",
                    "status": "pending",
                    "user_id": user.user_id,
                },
            )
            if status != 201 or not body or "id" not in body:
                return
            task_id = body["id"]
            ok += 1

            # SELECT (list)
            status, body = await timed_request(
                client, "GET", f"{base}/tasks?limit=10",
                metrics, "GET /v1/:app/tasks",
                timeout=cfg.timeout_seconds,
                headers=headers,
            )
            if 200 <= status < 300:
                ok += 1

            # UPDATE
            status, body = await timed_request(
                client, "PATCH", f"{base}/tasks/{task_id}",
                metrics, "PATCH /v1/:app/tasks/:id",
                timeout=cfg.timeout_seconds,
                headers=headers,
                json={"status": "completed"},
            )
            if 200 <= status < 300:
                ok += 1

            # DELETE — use API key, no Content-Type (no body)
            admin_headers = make_headers(cfg.api_key, with_content_type=False)
            status, body = await timed_request(
                client, "DELETE", f"{base}/tasks/{task_id}",
                metrics, "DELETE /v1/:app/tasks/:id",
                timeout=cfg.timeout_seconds,
                headers=admin_headers,
            )
            if 200 <= status < 300:
                ok += 1

    tasks = [crud_cycle(u) for u in users]
    await asyncio.gather(*tasks)
    print(f"  Completed {ok}/{total_ops} CRUD operations successfully.")


# ---------------------------------------------------------------------------
# Phase 5: Storage Burst
# ---------------------------------------------------------------------------

async def phase_storage_burst(
    client: httpx.AsyncClient, cfg: Config, metrics: Metrics, apps: list[dict]
) -> None:
    """Each app requests a presigned upload URL, uploads a small file, lists objects."""
    total = len(apps)
    print(f"\n[Phase 5] Storage burst: {total} apps x upload+list (batch size: {cfg.batch_size_storage})...")
    sem = asyncio.Semaphore(cfg.batch_size_storage)
    headers = make_headers(cfg.api_key)
    ok = 0

    async def storage_cycle(app_info: dict):
        nonlocal ok
        async with sem:
            app_id = app_info["app_id"]
            filename = f"stress-{random_string(6)}.txt"

            # Request presigned upload URL
            status, body = await timed_request(
                client, "POST", f"{cfg.base_url}/storage/{app_id}/upload",
                metrics, "POST /storage/upload",
                timeout=cfg.timeout_seconds,
                headers=headers,
                json={
                    "filename": filename,
                    "contentType": "text/plain",
                    "sizeBytes": 1024,
                },
            )
            if status != 200 or not body:
                return

            upload_url = body.get("uploadUrl") or body.get("url")
            object_id = body.get("objectId")

            # Upload to presigned URL
            if upload_url:
                payload = b"x" * 1024
                start = time.monotonic()
                try:
                    resp = await client.put(
                        upload_url,
                        content=payload,
                        headers={"Content-Type": "text/plain"},
                        timeout=cfg.timeout_seconds,
                    )
                    elapsed = time.monotonic() - start
                    metrics.record("PUT presigned-upload", elapsed, resp.status_code)
                    if 200 <= resp.status_code < 300:
                        ok += 1
                except Exception:
                    elapsed = time.monotonic() - start
                    metrics.record("PUT presigned-upload", elapsed, 0)

            # List objects
            status, body = await timed_request(
                client, "GET", f"{cfg.base_url}/storage/{app_id}/objects",
                metrics, "GET /storage/objects",
                timeout=cfg.timeout_seconds,
                headers=headers,
            )
            if 200 <= status < 300:
                ok += 1

            # Download (if we have an object_id)
            if object_id:
                status, body = await timed_request(
                    client, "GET",
                    f"{cfg.base_url}/storage/{app_id}/download/{object_id}",
                    metrics, "GET /storage/download",
                    timeout=cfg.timeout_seconds,
                    headers=headers,
                )
                if 200 <= status < 300:
                    ok += 1

    tasks = [storage_cycle(a) for a in apps]
    await asyncio.gather(*tasks)
    print(f"  Completed {ok} storage operations successfully.")


# ---------------------------------------------------------------------------
# Phase 6: Realtime Soak
# ---------------------------------------------------------------------------

async def phase_realtime_soak(
    client: httpx.AsyncClient, cfg: Config, metrics: Metrics, apps: list[dict], users: list[AppUser]
) -> None:
    """Open WebSocket connections and subscribe to changes, then fire inserts to generate events."""
    import websockets

    total = len(apps)
    print(f"\n[Phase 6] Realtime soak: {total} WebSocket connections for {cfg.realtime_soak_seconds}s (batch size: {cfg.batch_size_realtime})...")
    sem = asyncio.Semaphore(cfg.batch_size_realtime)

    ws_url_base = cfg.base_url.replace("https://", "wss://").replace("http://", "ws://")

    connections_opened = 0
    events_received = 0
    connection_errors = 0

    async def ws_subscriber(app_info: dict):
        nonlocal connections_opened, events_received, connection_errors
        async with sem:
            app_id = app_info["app_id"]
            url = f"{ws_url_base}/v1/{app_id}/realtime?token={cfg.api_key}"

            start = time.monotonic()
            try:
                async with websockets.connect(url, close_timeout=5) as ws:
                    elapsed = time.monotonic() - start
                    metrics.record("WS connect", elapsed, 101)
                    connections_opened += 1

                    # Wait for welcome message
                    try:
                        await asyncio.wait_for(ws.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        pass

                    # Subscribe to tasks table
                    await ws.send(json.dumps({"type": "subscribe", "table": "tasks"}))

                    # Listen for events for the soak duration
                    deadline = time.monotonic() + cfg.realtime_soak_seconds
                    while time.monotonic() < deadline:
                        try:
                            await asyncio.wait_for(ws.recv(), timeout=2)
                            events_received += 1
                        except asyncio.TimeoutError:
                            continue
                        except websockets.exceptions.ConnectionClosed:
                            break

                    metrics.record("WS soak", time.monotonic() - start, 200)

            except Exception:
                elapsed = time.monotonic() - start
                metrics.record("WS connect", elapsed, 0)
                connection_errors += 1

    # Start WebSocket connections
    ws_tasks = [ws_subscriber(a) for a in apps]

    # Also fire some CRUD inserts during the soak to generate change events
    async def insert_during_soak():
        authed = [u for u in users if u.access_token]
        if not authed:
            return
        sample_size = min(len(authed), cfg.num_apps)
        sample = random.sample(authed, sample_size)
        await asyncio.sleep(2)  # Wait for WS connections to establish
        insert_tasks = []
        insert_sem = asyncio.Semaphore(cfg.batch_size_crud)

        async def do_insert(user: AppUser):
            async with insert_sem:
                headers = make_headers(user.access_token)
                await timed_request(
                    client, "POST",
                    f"{cfg.base_url}/v1/{user.app_id}/tasks",
                    metrics, "POST /v1/:app/tasks (realtime)",
                    timeout=cfg.timeout_seconds,
                    headers=headers,
                    json={
                        "title": f"Realtime test {random_string(4)}",
                        "status": "pending",
                        "user_id": user.user_id,
                    },
                )

        for u in sample:
            insert_tasks.append(do_insert(u))
        await asyncio.gather(*insert_tasks)

    await asyncio.gather(
        asyncio.gather(*ws_tasks),
        insert_during_soak(),
    )

    print(f"  Connections opened: {connections_opened}, Events received: {events_received}, Errors: {connection_errors}")


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

async def cleanup_apps(client: httpx.AsyncClient, cfg: Config, metrics: Metrics, apps: list[dict]) -> None:
    """Delete all test apps."""
    print(f"\n[Cleanup] Deleting {len(apps)} test apps...")
    sem = asyncio.Semaphore(cfg.batch_size_apps)
    headers = make_headers(cfg.api_key, with_content_type=False)  # DELETE has no body
    ok = 0

    async def delete_app(app_info: dict):
        nonlocal ok
        async with sem:
            status, body = await timed_request(
                client, "DELETE",
                f"{cfg.base_url}/apps/{app_info['app_id']}",
                metrics, "DELETE /apps/:id",
                timeout=60,
                headers=headers,
            )
            if 200 <= status < 300:
                ok += 1
            else:
                detail = ""
                if body and isinstance(body, dict):
                    detail = f" — {body.get('error', body.get('message', ''))}"
                print(f"  WARN: Delete {app_info['app_id']}: HTTP {status}{detail}")

    tasks = [delete_app(a) for a in apps]
    await asyncio.gather(*tasks)
    print(f"  Deleted {ok}/{len(apps)} apps.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main(cfg: Config):
    phases = set(cfg.phases.split(",")) if cfg.phases != "all" else {"apps", "schema", "auth", "crud", "storage", "realtime"}
    metrics = Metrics()
    apps: list[dict] = []
    users: list[AppUser] = []

    limits = httpx.Limits(max_connections=500, max_keepalive_connections=200)
    async with httpx.AsyncClient(limits=limits, follow_redirects=True) as client:
        try:
            # Phase 1: App Setup (always needed)
            if "apps" in phases:
                apps = await phase_app_setup(client, cfg, metrics)
                if not apps:
                    print("\nERROR: No apps created. Aborting.")
                    return

            # Phase 2: Schema
            if "schema" in phases and apps:
                await phase_schema_apply(client, cfg, metrics, apps)

            # Phase 3: Auth
            if "auth" in phases and apps:
                users = await phase_auth_flood(client, cfg, metrics, apps)

            # Phase 4: CRUD
            if "crud" in phases and users:
                await phase_crud_storm(client, cfg, metrics, users)

            # Phase 5: Storage
            if "storage" in phases and apps:
                await phase_storage_burst(client, cfg, metrics, apps)

            # Phase 6: Realtime
            if "realtime" in phases and apps:
                await phase_realtime_soak(client, cfg, metrics, apps, users)

        finally:
            if apps and not cfg.skip_cleanup:
                await cleanup_apps(client, cfg, metrics, apps)

    # Print report
    print("\n\n===== STRESS TEST RESULTS =====")
    print(f"Target: {cfg.base_url}")
    print(f"Apps: {cfg.num_apps}, Users/app: {cfg.users_per_app}")
    print(f"Phases: {cfg.phases}")
    metrics.print_report()

    # Save to JSON
    results = {
        "config": {
            "base_url": cfg.base_url,
            "num_apps": cfg.num_apps,
            "users_per_app": cfg.users_per_app,
            "phases": cfg.phases,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "metrics": metrics.report(),
    }
    with open("stress_test_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\nResults saved to stress_test_results.json")


def parse_args() -> Config:
    parser = argparse.ArgumentParser(description="Butterbase Hackathon Stress Test")
    parser.add_argument("--base-url", default=None, help="Server base URL")
    parser.add_argument("--api-key", default=None, help="Butterbase API key (bb_sk_...)")
    parser.add_argument("--num-apps", type=int, default=200, help="Number of apps to create")
    parser.add_argument("--users-per-app", type=int, default=10, help="End-users per app")
    parser.add_argument("--batch-size-apps", type=int, default=20)
    parser.add_argument("--batch-size-schema", type=int, default=50)
    parser.add_argument("--batch-size-auth", type=int, default=100)
    parser.add_argument("--batch-size-crud", type=int, default=200)
    parser.add_argument("--batch-size-storage", type=int, default=50)
    parser.add_argument("--batch-size-realtime", type=int, default=50)
    parser.add_argument("--realtime-soak-seconds", type=int, default=30)
    parser.add_argument("--skip-cleanup", action="store_true", help="Don't delete apps after test")
    parser.add_argument("--phases", default="all", help="Comma-separated phases: apps,schema,auth,crud,storage,realtime")
    parser.add_argument("--timeout", type=int, default=30, help="Per-request timeout in seconds")

    args = parser.parse_args()

    cfg = Config()
    cfg.base_url = args.base_url or os.environ.get("BUTTERBASE_BASE_URL", cfg.base_url)

    raw_key = args.api_key or os.environ.get("BUTTERBASE_API_KEY", "")
    # Strip "Bearer " prefix if user accidentally included it
    if raw_key.startswith("Bearer "):
        raw_key = raw_key[len("Bearer "):]
    cfg.api_key = raw_key

    cfg.num_apps = args.num_apps
    cfg.users_per_app = args.users_per_app
    cfg.batch_size_apps = args.batch_size_apps
    cfg.batch_size_schema = args.batch_size_schema
    cfg.batch_size_auth = args.batch_size_auth
    cfg.batch_size_crud = args.batch_size_crud
    cfg.batch_size_storage = args.batch_size_storage
    cfg.batch_size_realtime = args.batch_size_realtime
    cfg.realtime_soak_seconds = args.realtime_soak_seconds
    cfg.skip_cleanup = args.skip_cleanup
    cfg.phases = args.phases
    cfg.timeout_seconds = args.timeout

    if not cfg.api_key:
        print("ERROR: --api-key or BUTTERBASE_API_KEY env var is required.")
        sys.exit(1)

    return cfg


if __name__ == "__main__":
    cfg = parse_args()

    print("=" * 60)
    print("  Butterbase Hackathon Stress Test")
    print("=" * 60)
    print(f"  Target:       {cfg.base_url}")
    print(f"  Apps:         {cfg.num_apps}")
    print(f"  Users/app:    {cfg.users_per_app}")
    print(f"  Total users:  {cfg.num_apps * cfg.users_per_app}")
    print(f"  Phases:       {cfg.phases}")
    print(f"  Cleanup:      {'skip' if cfg.skip_cleanup else 'enabled'}")
    print("=" * 60)

    asyncio.run(main(cfg))
