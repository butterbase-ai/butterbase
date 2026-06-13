# Moving an app to another region

Butterbase apps live in a specific region (us-east-1, eu-west-1, etc.). You can move an app to a different region at any time — for example, to be closer to your users, comply with data residency rules, or test a multi-region migration before rolling out broadly.

## What happens during a move

A move takes 5–30 minutes depending on data size. During the move:

- **Reads continue to work** at full latency.
- **Writes are paused** with HTTP 503 + Retry-After=60. Clients that respect Retry-After will auto-retry once the move completes.
- **Background functions** continue to run on the source until cutover, then resume on the destination.

After the move completes, the previous region is kept as a hot replica for fast rollback. You can keep it indefinitely (with ongoing cost) or tear it down via the dashboard.

## How to initiate

### Dashboard (recommended)

1. Open your app's settings page.
2. Under "Region", click **Move app to another region**.
3. Select the destination region from the dropdown.
4. Confirm.
5. The progress page shows real-time status. Friendly step labels (e.g., "Backing up your data", "Switching traffic") indicate what's happening.

### MCP

Use the `manage_app` MCP tool (action: `"move"`):
```
manage_app({ action: "move", app_id: "app-123", dest_region: "eu-west-1" })
```
Poll status with `manage_app({ action: "move_status", migration_id: "..." })`.

### REST API

```
POST /v1/apps/<app-id>/move
{ "dest_region": "eu-west-1" }
```
Returns 202 `{ migration_id, status: "queued" }`. Poll `GET /v1/apps/<app-id>/migrations/<migration-id>` for status.

## Abort before cutover

If something looks wrong during the early phase, you can abort:

- **Dashboard:** click "Abort" on the progress page (visible until cutover).
- **API:** `POST /v1/apps/<app-id>/migrations/<migration-id>/abort`.

Abort is allowed up through the `copying_runtime` step. After `flipping_routing` (the cutover), abort is rejected with 409 — use reverse-move instead.

## Reverse-move (rollback after cutover)

After a move completes, you can reverse it from the dashboard ("Reverse move" button) or via:
```
POST /v1/apps/<app-id>/migrations/<migration-id>/reverse
```
The response includes `{ migrationId, path: "fast" | "slow" }`:

- **Fast path** (~minutes): the source region is still a live replica — we promote it back and flip routing. Used when `source_replica_state="replicating"`.
- **Slow path** (5–30 min): full saga in reverse with a fresh dump. Used when the replica has been deleted or expired.

## Source replica retention

By default the source region is kept as a hot replica for fast reverse-move. **It incurs ongoing cost** (storage + compute on the publisher side keeping it warm).

To list and delete retained replicas:
- **Dashboard:** Account → Replicas.
- **API:** `GET /v1/source-replicas`, `DELETE /v1/source-replicas/<migration-id>`.

After deleting a replica, reverse-move falls back to the slow path.

## Client-side handling of 503

If your client code writes to a Butterbase app during a move, you'll get HTTP 503 + `Retry-After: 60` with body `{ error: "app_migrating" }`. Recommended:

- Respect the Retry-After header.
- For long-running batch jobs, check status via the dashboard before resuming.
- The dashboard SDK throws `AppMigratingError` so you can branch in error handlers.

## FAQ

**Will end users notice?** Reads stay fast. Writes get 503 for the 5-30 min window — clients with retry logic will recover automatically.

**Is data lost if a step fails?** No. The saga is idempotent — failed steps retry up to 5 times. After 5 retries the migration is marked `failed` and you can either abort + try again or contact support.

**Can I move while the dashboard's offline?** Yes — use the API or MCP. The dashboard is just a friendly wrapper.

**What if I have custom domains?** They follow the app automatically (Cloudflare KV is updated atomically during cutover).
