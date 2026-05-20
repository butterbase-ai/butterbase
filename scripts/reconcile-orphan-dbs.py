#!/usr/bin/env python3
"""
Reconcile data-plane databases against control-plane app records.

Lists all databases matching `db_app_*` (Neon) or `app_*` (local) on the
data-plane instance, cross-references them with the `apps` table in the
control-plane database, and drops any that have no corresponding app record.

Modes
-----
  neon   – Uses the Neon HTTP API to list and delete databases (production).
  direct – Connects to Postgres directly via psycopg2 (local dev / self-hosted).

The mode is auto-detected from NEON_API_KEY presence, or forced with --mode.

Usage
-----
  # Dry-run (default) — shows what would be deleted
  python scripts/reconcile-orphan-dbs.py

  # Actually delete orphans
  python scripts/reconcile-orphan-dbs.py --execute

  # Force direct Postgres mode even when NEON env vars are set
  python scripts/reconcile-orphan-dbs.py --mode direct --execute

Environment variables
---------------------
  CONTROL_DB_URL               Control-plane connection string
                               (default: postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control)

  Direct mode:
    DATA_PLANE_DB_HOST         (default: localhost)
    DATA_PLANE_DB_PORT         (default: 5435)
    DATA_PLANE_DB_USER         (default: butterbase)
    DATA_PLANE_DB_PASSWORD     (default: butterbase_dev)

  Neon mode:
    NEON_API_KEY               Neon Console API key
    NEON_DATA_PROJECT_ID       Neon project ID for the data plane
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

try:
    import psycopg2
    import psycopg2.extensions
except ImportError:
    psycopg2 = None  # type: ignore[assignment]

# ── Configuration ──────────────────────────────────────────────

# Phase 2: single-region — apps is a runtime table; use NEON_RUNTIME_PROJECT_ID_US_EAST_1.
# CONTROL_DB_URL is kept as fallback for local-dev mode.
RUNTIME_DB_URL = os.environ.get(
    "NEON_RUNTIME_PROJECT_ID_US_EAST_1",
    os.environ.get(
        "CONTROL_DB_URL",
        "postgresql://butterbase:butterbase_dev@localhost:5433/butterbase_control",
    ),
)

DATA_PLANE_HOST = os.environ.get("DATA_PLANE_DB_HOST", "localhost")
DATA_PLANE_PORT = int(os.environ.get("DATA_PLANE_DB_PORT", "5435"))
DATA_PLANE_USER = os.environ.get("DATA_PLANE_DB_USER", "butterbase")
DATA_PLANE_PASSWORD = os.environ.get("DATA_PLANE_DB_PASSWORD", "butterbase_dev")

NEON_API_KEY = os.environ.get("NEON_API_KEY", "")
NEON_PROJECT_ID = os.environ.get("NEON_DATA_PROJECT_ID", "")
NEON_BASE_URL = "https://console.neon.tech/api/v2"

# Neon names databases as db_{app_id} → db_app_xxxxxxxxxxxx
# Local mode names them as {app_id} → app_xxxxxxxxxxxx
DB_PREFIX_NEON = "db_app_"
DB_PREFIX_LOCAL = "app_"


# ── Neon API helpers ───────────────────────────────────────────

def neon_request(path: str, method: str = "GET", retries: int = 4) -> dict:
    url = f"{NEON_BASE_URL}{path}"
    req = urllib.request.Request(
        url,
        method=method,
        headers={
            "Authorization": f"Bearer {NEON_API_KEY}",
            "Content-Type": "application/json",
        },
    )
    backoff = [0.5, 1, 2, 4]
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req) as resp:
                if method == "DELETE":
                    return {}
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code in (423, 500, 502, 503) and attempt < retries:
                time.sleep(backoff[min(attempt, len(backoff) - 1)])
                continue
            body = e.read().decode(errors="replace")
            print(f"  Neon API error {e.code} {path}: {body}", file=sys.stderr)
            raise
    raise RuntimeError(f"Neon API: max retries exceeded for {path}")


def neon_get_default_branch_id(project_id: str) -> str:
    data = neon_request(f"/projects/{project_id}/branches")
    for branch in data.get("branches", []):
        if branch.get("default"):
            return branch["id"]
    raise RuntimeError(f"No default branch found for project {project_id}")


def neon_list_databases(project_id: str, branch_id: str) -> list[dict]:
    data = neon_request(f"/projects/{project_id}/branches/{branch_id}/databases")
    return data.get("databases", [])


def neon_delete_database(project_id: str, branch_id: str, db_name: str) -> None:
    neon_request(
        f"/projects/{project_id}/branches/{branch_id}/databases/{db_name}",
        method="DELETE",
    )


# ── Direct Postgres helpers ────────────────────────────────────

def pg_list_app_databases() -> list[str]:
    if psycopg2 is None:
        print("psycopg2 is required for direct mode: pip install psycopg2-binary", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(
        host=DATA_PLANE_HOST,
        port=DATA_PLANE_PORT,
        user=DATA_PLANE_USER,
        password=DATA_PLANE_PASSWORD,
        dbname="postgres",
    )
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT datname FROM pg_database "
                "WHERE datname LIKE 'db\\_app\\_%' OR datname LIKE 'app\\_%' "
                "ORDER BY datname"
            )
            return [row[0] for row in cur.fetchall()]
    finally:
        conn.close()


def pg_drop_database(db_name: str) -> None:
    if psycopg2 is None:
        raise RuntimeError("psycopg2 not installed")

    conn = psycopg2.connect(
        host=DATA_PLANE_HOST,
        port=DATA_PLANE_PORT,
        user=DATA_PLANE_USER,
        password=DATA_PLANE_PASSWORD,
        dbname="postgres",
    )
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
    try:
        with conn.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
    finally:
        conn.close()


# ── Control-plane queries ──────────────────────────────────────

def get_control_plane_app_ids() -> set[str]:
    """Fetch app IDs from the runtime DB (apps is a runtime table)."""
    if psycopg2 is None:
        print("psycopg2 is required: pip install psycopg2-binary", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(RUNTIME_DB_URL)
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM apps")
            return {row[0] for row in cur.fetchall()}
    finally:
        conn.close()


# ── Reconciliation logic ──────────────────────────────────────

def extract_app_id(db_name: str) -> str | None:
    """Extract the app_xxx ID from a database name."""
    if db_name.startswith(DB_PREFIX_NEON):
        # db_app_xxxxxxxxxxxx → app_xxxxxxxxxxxx
        return db_name[3:]  # strip leading "db_"
    if db_name.startswith(DB_PREFIX_LOCAL):
        return db_name
    return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Delete orphaned app databases from the data plane."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually delete orphans (default is dry-run).",
    )
    parser.add_argument(
        "--mode",
        choices=["neon", "direct"],
        default=None,
        help="Force connection mode. Auto-detected if omitted.",
    )
    args = parser.parse_args()

    # Auto-detect mode
    mode = args.mode
    if mode is None:
        mode = "neon" if (NEON_API_KEY and NEON_PROJECT_ID) else "direct"

    dry_run = not args.execute
    if dry_run:
        print("=== DRY RUN (pass --execute to actually delete) ===\n")

    print(f"Mode: {mode}")

    # 1. List data-plane databases
    print("\n── Step 1: List data-plane databases ──")
    if mode == "neon":
        if not NEON_API_KEY or not NEON_PROJECT_ID:
            print(
                "NEON_API_KEY and NEON_DATA_PROJECT_ID must be set for neon mode.",
                file=sys.stderr,
            )
            sys.exit(1)

        branch_id = neon_get_default_branch_id(NEON_PROJECT_ID)
        all_neon_dbs = neon_list_databases(NEON_PROJECT_ID, branch_id)
        # Filter to app databases only
        data_plane_dbs = [
            db["name"]
            for db in all_neon_dbs
            if db["name"].startswith(DB_PREFIX_NEON)
        ]
    else:
        branch_id = ""  # unused in direct mode
        data_plane_dbs = pg_list_app_databases()

    print(f"Found {len(data_plane_dbs)} app database(s) on the data plane.")
    for name in data_plane_dbs:
        print(f"  {name}")

    # 2. Fetch control-plane app IDs
    print("\n── Step 2: Fetch control-plane app records ──")
    app_ids = get_control_plane_app_ids()
    print(f"Found {len(app_ids)} app(s) in the control plane.")

    # 3. Find orphans
    print("\n── Step 3: Reconcile ──")
    orphans: list[str] = []
    for db_name in data_plane_dbs:
        app_id = extract_app_id(db_name)
        if app_id is None:
            print(f"  [SKIP] {db_name} — could not extract app ID")
            continue
        if app_id in app_ids:
            print(f"  [OK]   {db_name} → {app_id}")
        else:
            print(f"  [ORPHAN] {db_name} → {app_id} (no matching app)")
            orphans.append(db_name)

    if not orphans:
        print("\nNo orphaned databases found. Nothing to do.")
        return

    print(f"\n{len(orphans)} orphaned database(s) to delete:")
    for name in orphans:
        print(f"  - {name}")

    # 4. Delete orphans
    if dry_run:
        print("\nDry run complete. Re-run with --execute to delete these databases.")
        return

    print("\n── Step 4: Deleting orphaned databases ──")
    deleted = 0
    failed = 0
    for db_name in orphans:
        try:
            if mode == "neon":
                neon_delete_database(NEON_PROJECT_ID, branch_id, db_name)
            else:
                pg_drop_database(db_name)
            print(f"  [DELETED] {db_name}")
            deleted += 1
        except Exception as e:
            print(f"  [FAILED]  {db_name}: {e}", file=sys.stderr)
            failed += 1

    print(f"\nDone. {deleted} deleted, {failed} failed.")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
