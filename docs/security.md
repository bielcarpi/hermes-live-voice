# Security Model

`hermes-live` sits between untrusted clients and a powerful private agent. Treat it as a security boundary.

## Do Not Expose Hermes Directly

Hermes may have terminal, file, browser, memory, and MCP capabilities. Do not put Hermes API credentials in mobile apps or browser code. The client should talk to `hermes-live`; `hermes-live` should talk to Hermes.

## Credentials

Server-side only:

- `HERMES_API_KEY`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- Vertex/Google Cloud credentials

Client-side allowed:

- `HERMES_LIVE_AUTH_TOKEN` only if it is scoped/revocable for gateway access.

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

## Abuse Handling

The gateway sends a hashed session key as `OpenAI-Safety-Identifier` when using OpenAI Realtime. This is privacy-preserving and stable enough for provider-side abuse monitoring.

Add your own rate limiting before public deployment.

## Public Deployment Checklist

- `HERMES_LIVE_AUTH_TOKEN` is set.
- `HERMES_LIVE_ALLOW_ORIGIN` is exact.
- Hermes API Server is private to the gateway network.
- TLS is enabled.
- Reverse proxy request size limits are configured.
- Logs do not include secrets.
- Provider and Hermes credentials are managed by the server environment.
- Rate limits exist at the edge.
