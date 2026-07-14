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

`HERMES_LIVE_AUTH_TOKEN` is an installation-wide shared bearer. Keep it server-side for production browser/community UIs. A direct browser may use it only in a trusted local or single-user development deployment where every person with page access is allowed to control the same gateway and Hermes identity.

Set `HERMES_AGENT_API_SERVER_KEY` to Hermes Agent's `API_SERVER_KEY`. Current Hermes API Server deployments require bearer auth for every deployment, including loopback, and `hermes-live` only sends `X-Hermes-Session-Key` memory scope headers when the Hermes client is authenticated. The gateway includes that server-side session key on run creation and follow-up run-scoped calls such as event streaming, status, stop, and approval.

`HERMES_API_KEY` remains supported as a legacy alias for existing deployments.

Client-supplied identity is not trusted by default. `HERMES_LIVE_PROFILE_ID` and `HERMES_LIVE_USER_LABEL` define the server-owned Hermes memory scope. `session.start.profileId` and `session.start.userLabel` are ignored unless the operator explicitly sets `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true` for a trusted-client deployment.

When `HERMES_LIVE_AUTH_TOKEN` is set, `WS /v1/live`, `GET /ready`, and `GET /v1/capabilities` require authentication. `GET /health` intentionally stays public for health checks.

When `HERMES_LIVE_HOST` is network-accessible, `hermes-live` refuses to start without a strong `HERMES_LIVE_AUTH_TOKEN`. Generate one with a command such as `openssl rand -hex 32`. Set `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` only for an isolated trusted network.

Use `Authorization: Bearer <token>` for HTTP endpoints and server-side clients. Query-token auth is accepted only for direct browser WebSocket clients that cannot set upgrade headers; treat the resulting URL as secret and prevent it from entering logs, analytics, referrers, screenshots, or support output.

For production browser clients, use an authenticated same-origin WebSocket proxy or a backend-issued short-lived ticket. The Hermes Dashboard integration implements the proxy pattern: Hermes authenticates the browser, the plugin backend revalidates the Dashboard WebSocket request, and only that backend applies `HERMES_LIVE_AUTH_TOKEN` to the upstream gateway connection. The browser never receives the shared bearer or upstream gateway URL.

The shared browser client accepts `webSocketUrlProvider` so community UIs can request a fresh host-authorized URL at connection time. The Hermes Live gateway does not currently mint per-user tickets or turn its shared bearer into multi-tenant identity.

## Built-in Demo

The browser demo is useful for local testing but should not be exposed accidentally. It is enabled by default for local development and disabled by default when `NODE_ENV=production`; set `HERMES_LIVE_DEMO_ENABLED=true` only when you intentionally want to serve it.

Static demo responses include `no-store`, `nosniff`, `no-referrer`, frame denial, and a restrictive content security policy.

## Origin Checks

Set:

```sh
HERMES_LIVE_ALLOW_ORIGIN=https://app.example.com
```

Use `*` only for local experiments.

Without an explicit allow-origin value, browser WebSocket upgrades are accepted only when both `Origin` and `Host` name localhost or a literal loopback address and their effective ports match. This prevents a public hostname that has been rebound to `127.0.0.1` from satisfying the default policy. Headerless terminal and native clients remain supported. Set `HERMES_LIVE_ALLOW_ORIGIN` to the exact browser origin when using any custom hostname.

Origin checks are defense in depth, not authentication. They do not make an embedded shared bearer safe and do not identify a user.

## Transport

Use `wss://` for non-local clients. Terminate TLS at a trusted reverse proxy and forward to the local gateway port.

## Approvals

Interactive approval is a negotiated capability, not an assumption. The gateway requires Hermes to advertise `run_approval_response_by_id: true`, emit a bounded stable `approval_id`, and echo the exact run, approval, choice, and single resolved count. Clients receive that negotiated state in `session.ready` and must not render positive approval controls when it is unavailable.

Hermes versions without targeted response identity are handled fail closed. The gateway never guesses which FIFO entry a visible event represents. It attempts `deny` with `resolve_all: true`, then stops the run and closes the voice session even if that denial was confirmed. The fatal `hermes_approval_identity_unsupported` error tells the operator to verify the run in Hermes before retrying. This is necessary because another authenticated controller could have resolved a different FIFO entry first; a denial count or empty queue cannot prove that the event this client observed was denied.

For targeted-capable Hermes versions, approval decisions should be rendered clearly in the client. The gateway does not decide whether a dangerous action should be approved, but it deliberately narrows what a client is allowed to approve.

Run-scoped actions are limited to the active Hermes run for the current voice session. Client messages and realtime provider tool calls cannot stop or inspect arbitrary Hermes run IDs through the gateway. The realtime provider has no approval-submission tool.

The gateway projects only exact, bounded approval display values. It never truncates or strips unsafe characters and then asks the user to approve the altered text. Opaque or incomplete requests are deny-only. `once` is available only when the user can see an exact command or description. `session` and `always` require an exact inspectable permission pattern, and interactive clients require a second confirmation before `always`.

Every interactive approval envelope receives a gateway-owned ID correlated to a bounded upstream Hermes approval identity. Responses must match the active run, exact queue-head approval ID, exact offered choice, and a previously unused client request ID. Hermes must then confirm the exact upstream run ID, approval ID, choice, and `resolved: 1`. Exact retries are acknowledged from a bounded idempotency cache; reuse with changed data, duplicate upstream identities, widened choices, out-of-order responses, and bulk resolution fail closed.

Mutating Hermes calls are treated as outcome-sensitive. If the gateway cannot determine whether an approval, run start, or stop took effect, it contains the owned run and closes the session rather than retrying against uncertain state. Graceful client disconnect waits for provider cleanup and active-run stop confirmation. If complete shutdown cannot be confirmed, the gateway emits `session_shutdown_unconfirmed`, closes with WebSocket code `1011`, and tells the operator to verify task state in Hermes.

## Abuse Handling

The gateway sends a hashed session key as `OpenAI-Safety-Identifier` when using OpenAI Realtime. This is privacy-preserving and stable enough for provider-side abuse monitoring.

Raw client WebSocket payload size is capped from `HERMES_LIVE_MAX_AUDIO_BYTES` and `HERMES_LIVE_MAX_TEXT_CHARS`, so oversized frames are closed before JSON parsing. Provider events, provider audio/transcripts, client/provider queues, gateway output buffering, Hermes JSON/SSE bodies, public run events, usage data, and CLI output have independent hard ceilings as well.

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
- Browser/community UIs use a same-origin authenticated WebSocket proxy or short-lived host-issued ticket instead of embedding the shared gateway bearer.
- Rate limits exist at the edge.
- `HERMES_LIVE_MAX_SESSIONS` matches provider quota and cost limits.
- `HERMES_LIVE_RUN_EVENT_DETAIL` is `summary` or `none` unless every client is trusted.
