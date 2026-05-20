---
title: Realtime
description: WebSocket-based real-time data change notifications with RLS-aware filtering and presence tracking.
---

Butterbase provides real-time data change notifications via WebSocket connections. When enabled on a table, any INSERT, UPDATE, or DELETE is broadcast to connected clients.

## Enabling realtime

```
configure_realtime({ app_id: "app_abc123", tables: ["messages", "notifications"] })
```

This installs database triggers that capture changes and broadcast them via pg_notify.

## Connecting via WebSocket

Connect to: `wss://api.butterbase.ai/v1/{app_id}/realtime`

### Authentication

**Browser clients (recommended):** Pass token as query parameter:

```
wss://api.butterbase.ai/v1/app_abc123/realtime?token=eyJhbG...
```

**Node.js / server-side:** Use Authorization header:

```javascript
const ws = new WebSocket('wss://api.butterbase.ai/v1/app_abc123/realtime', {
  headers: { Authorization: 'Bearer <jwt>' }
});
```

| Auth method | Role assigned |
|-------------|--------------|
| End-user JWT | butterbase_user (RLS enforced) |
| API key (`bb_sk_...`) | butterbase_service (sees all changes) |
| No auth | butterbase_anon |

## Client protocol

```json
// Client -> Server
{ "type": "subscribe", "table": "messages" }
{ "type": "unsubscribe", "table": "messages" }

// Server -> Client
{ "type": "connected", "app_id": "app_abc123", "role": "butterbase_user" }
{ "type": "subscribed", "table": "messages" }
{ "type": "change", "table": "messages", "op": "INSERT", "record": {...}, "old_record": null, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "UPDATE", "record": {...}, "old_record": {...}, "timestamp": "..." }
{ "type": "change", "table": "messages", "op": "DELETE", "record": null, "old_record": {...}, "timestamp": "..." }
{ "type": "heartbeat", "timestamp": "..." }
{ "type": "error", "message": "..." }
```

## Browser example

```javascript
const token = 'eyJhbG...'; // end-user JWT
const ws = new WebSocket(`wss://api.butterbase.ai/v1/app_abc123/realtime?token=${token}`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'subscribe', table: 'messages' }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'change') {
    console.log(msg.op, msg.table, msg.record);
  }
};
```

## Subscription filters

Subscribe to a subset of changes:

```json
{ "type": "subscribe", "table": "messages", "filter": { "channel_id": "abc" } }
```

Only changes where `channel_id = 'abc'` will be delivered. Filters match on exact column equality.

## Row-level security

RLS is enforced on realtime events:
- **butterbase_user** — Only receives changes for rows they can SELECT
- **butterbase_service** — Receives all changes
- **butterbase_anon** — Receives changes based on anon policies

## Presence tracking

Track who else is connected:

```json
// Opt in with metadata
{ "type": "presence_track", "metadata": { "name": "Alice", "cursor": { "x": 10, "y": 20 } } }

// Update metadata (e.g. cursor moved)
{ "type": "presence_update", "metadata": { "cursor": { "x": 50, "y": 60 } } }
```

Server broadcasts to all presence-tracking clients:

```json
{ "type": "presence_state", "clients": [{ "client_id": "...", "user_id": "...", "metadata": {...} }] }
{ "type": "presence_join", "client_id": "...", "user_id": "...", "metadata": {...} }
{ "type": "presence_update", "client_id": "...", "metadata": {...} }
{ "type": "presence_leave", "client_id": "...", "user_id": "..." }
```

Presence is in-memory only — it resets on server restart.

## WebSocket triggers

Deploy functions that fire when clients send custom events:

```
deploy_function({
  name: "handle-chat",
  code: "...",
  trigger: { type: "websocket", config: { event: "chat_message" } }
})
```

Clients send events:
```json
{ "type": "event", "event": "chat_message", "payload": { "text": "hello" } }
```

The function response is returned:
```json
{ "type": "event_response", "event": "chat_message", "data": { "echo": { "text": "hello" } } }
```

## Limitations

- Tables must exist before enabling realtime
- The full row is sent on each change (no column filtering yet)
- Events during LISTEN reconnection may be lost — clients should re-fetch state on reconnect
