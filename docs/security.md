# Security Model

`hermes-live` sits between untrusted clients and a powerful private agent. Treat it as a security boundary.

## Do Not Expose Hermes Directly

Hermes may have terminal, file, browser, memory, and MCP capabilities. Do not put Hermes API credentials in mobile apps or browser code. The client should talk to `hermes-live`; `hermes-live` should talk to Hermes.

## Credentials

Server-side only:

- `HERMES_AGENT_API_SERVER_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- Vertex/Google Cloud credentials

Client-side allowed:

- `HERMES_LIVE_AUTH_TOKEN` only if it is scoped/revocable for gateway access.

Set `HERMES_AGENT_API_SERVER_KEY` to Hermes Agent's `API_SERVER_KEY`. Current Hermes API Server deployments require bearer auth for every deployment, including loopback, and `hermes-live` only sends `X-Hermes-Session-Key` memory scope headers when the Hermes client is authenticated. The gateway includes that server-side session key on run creation and follow-up run-scoped calls such as event streaming, status, stop, and approval.

`HERMES_API_KEY` remains supported as a legacy alias for existing deployments.

Client-supplied identity is not trusted by default. `HERMES_LIVE_PROFILE_ID` and `HERMES_LIVE_USER_LABEL` define the server-owned Hermes memory scope. `session.start.profileId` and `session.start.userLabel` are ignored unless the operator explicitly sets `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true` for a trusted-client deployment.

When `HERMES_LIVE_AUTH_TOKEN` is set, `WS /v1/live`, `GET /ready`, and `GET /v1/capabilities` require authentication. `GET /health` intentionally stays public for health checks.

When `HERMES_LIVE_HOST` is network-accessible, `hermes-live` refuses to start without a strong `HERMES_LIVE_AUTH_TOKEN`. Generate one with a command such as `openssl rand -hex 32`. Set `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` only for an isolated trusted network.

Use `Authorization: Bearer <token>` for HTTP endpoints and server-side clients. Query-token auth is accepted only for browser WebSocket clients that cannot set upgrade headers.

## Built-in Demo

The browser demo is useful for local testing but should not be exposed accidentally. It is enabled by default for local development and disabled by default when `NODE_ENV=production`; set `HERMES_LIVE_DEMO_ENABLED=true` only when you intentionally want to serve it.

Static demo responses include `no-store`, `nosniff`, `no-referrer`, frame denial, and a restrictive content security policy.

## Origin Checks

Set:

```sh
HERMES_LIVE_ALLOW_ORIGIN=https://app.example.com
```

Use `*` only for local experiments.

## Transport

Use `wss://` for non-local clients. Terminate TLS at a trusted reverse proxy and forward to the local gateway port.

## Approvals

Approval decisions should be rendered clearly in the client. The gateway only forwards choices; it does not decide whether a dangerous action should be approved.

Run-scoped actions are limited to the active Hermes run for the current voice session. Client messages and realtime provider tool calls cannot stop, inspect, or approve arbitrary Hermes run IDs through the gateway.

## Abuse Handling

The gateway sends a hashed session key as `OpenAI-Safety-Identifier` when using OpenAI Realtime. This is privacy-preserving and stable enough for provider-side abuse monitoring.

Raw client WebSocket payload size is capped from `HERMES_LIVE_MAX_AUDIO_BYTES` and `HERMES_LIVE_MAX_TEXT_CHARS`, so oversized frames are closed before JSON parsing.

Client metadata fields are also bounded before dispatch, including profile IDs, user labels, run IDs, reasons, MIME types, and playback truncation values.

Hermes run events can contain tool arguments, output, paths, errors, or other operational detail. The default `HERMES_LIVE_RUN_EVENT_DETAIL=summary` policy emits only allowlisted event metadata. Use `none` to suppress run events or `raw` only when the client is fully trusted to receive upstream Hermes payloads.

The gateway enforces `HERMES_LIVE_MAX_SESSIONS` before opening another provider session. Keep that limit aligned with provider quotas and cost controls.

Add your own rate limiting before public deployment.

## Public Deployment Checklist

- `HERMES_LIVE_AUTH_TOKEN` is set to a high-entropy value.
- `HERMES_AGENT_API_SERVER_KEY` is set to Hermes Agent's `API_SERVER_KEY`.
- `HERMES_LIVE_ALLOW_ORIGIN` is exact.
- `HERMES_LIVE_DEMO_ENABLED=false` if the public browser demo is not intentionally exposed.
- Hermes API Server is private to the gateway network.
- TLS is enabled.
- Reverse proxy request size limits are configured.
- Logs do not include secrets.
- Provider and Hermes credentials are managed by the server environment.
- Rate limits exist at the edge.
- `HERMES_LIVE_MAX_SESSIONS` matches provider quota and cost limits.
- `HERMES_LIVE_RUN_EVENT_DETAIL` is `summary` or `none` unless every client is trusted.
