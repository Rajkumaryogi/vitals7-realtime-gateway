# vitals7-realtime-gateway

Small **central SSE hub** for Vitals7: device connectors call one **publish** endpoint after sync/webhooks; the Vitals7 SPA opens **one EventSource** per signed-in user instead of per-connector SSE or short-interval polling.

## Quick start

```bash
npm install
npm run dev
```

Default listen: **http://localhost:8095**

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8095` | HTTP port |
| `VITALS_REALTIME_GATEWAY_SECRET` | `vitals7-local-dev-realtime` | Shared secret for `POST /internal/publish` (`X-Gateway-Secret` header) |

Use a strong secret in production; set the **same** value on every connector that publishes (see each service’s `VITALS_REALTIME_GATEWAY_*` env or equivalent).

## HTTP API

### `GET /health`

JSON liveness: `{ ok, service, clients }` (`clients` is the number of user IDs that currently have at least one open SSE connection).

### `GET /events/:userId`

**Server-Sent Events** stream for the Vitals7 user. `:userId` must be the Cognito **`sub`** (same identifier connectors use when publishing).

- First message: `{ type: "connected", ts }`.
- Later messages: `{ type, source, data, ts }` (defaults: `type: "vitals7_refresh"`, `source: "unknown"` if omitted in publish body).

**CORS:** `Access-Control-Allow-Origin` is set only for allowed origins (localhost / 127.0.0.1 / `https://dev-app.vitals7.com`). Add more in `src/server.js` if you deploy the SPA on another host.

### `POST /internal/publish`

**Headers:** `Content-Type: application/json`, `X-Gateway-Secret: <same as VITALS_REALTIME_GATEWAY_SECRET>`

**Body (JSON):**

| Field | Required | Description |
|-------|----------|-------------|
| `userId` | yes | Cognito `sub` |
| `type` | no | Event type (default `vitals7_refresh`) |
| `source` | no | Connector name (default `unknown`) |
| `data` | no | Optional JSON-serializable payload |

**Response:** `{ ok: true, delivered }` — `delivered` is how many open SSE connections received the event for that user.

## Vitals7 app (dev)

In `vitals7-app`, `amplify.config.ts` sets `realtimeGatewayTarget` (e.g. `http://localhost:8095`) and `realtimeEventsPathPrefix` (e.g. `/realtime`). Vite proxies `/realtime` → the gateway and strips the prefix so the gateway still sees `/events/:userId`.

If the SPA and gateway are on **different origins** in production, set `realtimeEventsBaseUrl` to the gateway’s public origin and ensure that origin is allowed in the gateway’s CORS logic.

## Security notes

- Treat `/internal/publish` as **private**: network-restrict or put it behind your internal mesh; the secret must not leak to browsers.
- Do not expose the publish URL or secret to the frontend; only connectors (server-side) should publish.