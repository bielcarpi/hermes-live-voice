# Security Model

Hermes Live sits between untrusted clients, realtime model providers, a private task store, and a powerful Hermes Agent. Treat the gateway as a security boundary, not as a public multi-tenant service.

## Network Boundary

Do not expose Hermes Agent directly to browsers or mobile apps. Clients talk to Hermes Live; only the gateway talks to Hermes.

When `HERMES_LIVE_HOST` is network-accessible, startup requires a `HERMES_LIVE_AUTH_TOKEN` of at least 16 characters. Generate a high-entropy value, terminate TLS before the gateway, and add edge rate limits. `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` is an unsafe opt-out for an isolated trusted network only.

When gateway auth is enabled:

- `WS /v1/live`, `GET /ready`, and `GET /v1/capabilities` require the bearer;
- `GET /health` remains public;
- server-side clients use `Authorization: Bearer <token>`;
- direct browser WebSockets may use a query token only when they cannot set upgrade headers.

Query-token URLs are secrets and must stay out of logs, analytics, referrers, screenshots, and support output. Production browser clients should use an authenticated same-origin WebSocket relay or a host-issued short-lived ticket. The Dashboard plugin implements the relay pattern and never returns the gateway token or upstream URL to browser code.

Set an exact `HERMES_LIVE_ALLOW_ORIGIN` for browser deployments. Without it, browser upgrades are accepted only for matching literal loopback/localhost origins and ports. Origin policy is defense in depth, not authentication.

## Credentials And Outbound Endpoints

Keep these server-side:

- `HERMES_AGENT_API_SERVER_KEY` (Hermes `API_SERVER_KEY`)
- `HERMES_LIVE_AUTH_TOKEN`
- `GEMINI_API_KEY` or Google Cloud credentials
- `OPENAI_API_KEY`

`HERMES_API_KEY` is a legacy alias for the Hermes key.

`HERMES_BASE_URL` must be a credential-free HTTP(S) root origin. Paths, query strings, fragments, and embedded user information are rejected. Hermes JSON, SSE, stop, and denial requests reject redirects, preventing prompts, the API bearer, and server-owned session scope from being replayed to another origin.

`OPENAI_REALTIME_BASE_URL` must be a credential-free WS(S) URL without a fragment. Custom path/query values are permitted but redacted from public diagnostics; WebSocket redirects are rejected. Gemini connections are pinned to the official Developer API or a validated regional Vertex endpoint, ignoring ambient SDK base-URL overrides.

Provider-controlled error bodies, close reasons, event MIME types, and tool names are not copied into public diagnostics. Non-success Hermes bodies are drained through a size limit and reduced to bounded status/path context.

## Identity And Authorization

The server derives one Hermes session key from its configured prefix, profile, and user label. The hash of that value is the durable task owner id. List, get, stop, subscription, and notification acknowledgement all verify that owner.

By default, client `profileId` and `userLabel` values are ignored. This means clients using the same gateway defaults share the same task inbox and Hermes memory scope. `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true` lets already-trusted clients choose a scope; it does not authenticate the strings, isolate tenants, or add per-user quotas.

Do not use the shared bearer plus trusted client identity as a multi-tenant authorization system. Put a real authenticated broker in front and map its user identity to isolated gateway/Hermes deployments or a future signed identity mechanism.

## Durable State File

`HERMES_LIVE_TASK_STATE_FILE` contains task prompts, titles, hashed owner ids, internal Hermes run/session ids, bounded event summaries, results, usage, and notification state. It does not contain provider or Hermes API keys, but task content may include credentials, source code, paths, customer data, or other sensitive material.

The store:

- requires an absolute path in a dedicated gateway-owned directory;
- creates/forces directory mode `0700` and file mode `0600` on supported Unix systems;
- rejects a symlinked file or directory and a directory owned by another Unix user;
- bounds document and record counts;
- writes through a private exclusive temporary file, `fsync`, atomic rename, and directory `fsync`;
- holds an exclusive lifetime lock so two gateway processes cannot write the same file;
- refuses to reset invalid JSON or schema-corrupt state;
- freezes further mutation if durability after rename cannot be confirmed.

Back up the state file as sensitive data. Stop the gateway before copying or moving it. Do not edit task status, owner, run id, or revision fields by hand. If an unclean exit leaves a lock, confirm that no gateway is running before using `hermes-live tasks unlock --confirm-no-gateway`; locks are never reclaimed by age. In Docker, persist `/var/lib/hermes-live` on a private volume, or gateway restart recovery and the task inbox are lost.

## Provider Data Boundary

The selected realtime provider receives:

- user audio/text;
- the gateway system instruction and four background-task tool definitions;
- task prompts/context that the provider chooses to delegate;
- immediate task receipts and bounded list/get/stop tool results;
- a generic completion digest used for spoken notification.

An exact retained result reaches the provider only when it calls `get_background_task`, normally because the user asks for details. Connected protocol clients receive their own sanitized task lifecycle independently.

The provider never receives Hermes/provider credentials, the server-owned Hermes session key, raw Hermes APIs/events, upstream run ids, the task state file, or approval authority. These controls protect credentials and action boundaries; they do not make conversational content private from the selected provider. Do not delegate data that provider is not allowed to process.

Task titles, summaries, and results are untrusted data. The realtime instruction forbids following instructions, links, commands, or tool requests embedded in them. UIs must render them as text, not executable HTML or trusted markup.

## Delegation And Concurrency

The provider can request only the gateway's four task operations. Task access remains owner-scoped and exact-id based.

Mutating or uncertain work must use `exclusive`. By default, the gateway clamps every provider request to that mode. `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true` opts into `parallel_read_only` work across model-declared disjoint resource keys. This metadata is policy input, not a sandbox; Hermes permissions, container isolation, filesystem permissions, network controls, and tool policy remain necessary.

Queue and session limits control accidental load, not hostile traffic. Keep `HERMES_LIVE_MAX_SESSIONS`, task concurrency, and queue bounds aligned with provider quota, Hermes capacity, and cost limits; add rate limiting before public exposure.

## Ambiguous Mutations

Hermes does not currently accept an idempotency key for run creation. The gateway automatically retries only definitive `429 rate_limit_exceeded` and `503 gateway_draining` rejections. A timeout, connection loss, malformed success, or other ambiguous POST outcome becomes internal `dispatch_unknown` and public `unknown`; it is not retried.

That state remains an admission fence because the original task may be running. Never change it to queued or repeat a mutating task until possible upstream work has been contained and the target resources audited. See [operator recovery](background-tasks.md#ambiguous-dispatch-fence).

An ambiguous stop also becomes `unknown`. The gateway never treats “stop requested” as terminal success and never guesses another run id.

## Approvals

Protocol v3 has no interactive approval request, response, button, or terminal command. The realtime provider has no approval tool.

When Hermes reports `waiting_for_approval`, the supervisor attempts `deny` with `resolve_all: true` and requests stop for that exact upstream run. The public projection is non-actionable. Hermes exposes a run-scoped response endpoint, but not enough per-request identity for safe concurrent approval from Hermes Live, so there is no human approval path.

Do not work around this boundary by constructing a local approval card from raw Hermes events or calling the Hermes approval endpoint from browser code.

## Recovery Boundaries

Client and provider disconnects do not cancel tasks. Gateway restart recovery depends on the private state file and the same live Hermes process retaining its upstream run state. Current Hermes run state does not survive a Hermes Agent restart; a confirmed missing run becomes `unknown`, not failed.

Persistence proves what the gateway recorded, not whether external side effects occurred. Review external systems before retrying an unknown task.

## Audio And Payload Safety

Raw WebSocket frames, decoded audio, text, ids, metadata, provider events, outbound buffering, Hermes JSON/SSE, task output, usage, notifications, logs, and CLI rendering have independent ceilings. Oversized or malformed known messages close/fail the session instead of being partially trusted.

PCM sample rates and output codecs are validated. The browser helper rejects unsupported G.711 output instead of interpreting it as PCM16. Provider and Hermes requests have bounded startup/header deadlines; established Hermes SSE streams also have an idle timeout refreshed by events or keepalive bytes.

OpenAI receives a hashed `OpenAI-Safety-Identifier` derived from the server-owned session key for provider-side abuse monitoring without sending the raw identity.

## Demo And Static Content

The bundled demo is enabled by default in development and disabled by default when `NODE_ENV=production`. Leave `HERMES_LIVE_DEMO_ENABLED=false` unless it is intentionally exposed. Static responses use no-store, nosniff, no-referrer, frame denial, and a restrictive content security policy.

## Deployment Checklist

- Use a high-entropy `HERMES_LIVE_AUTH_TOKEN` and exact `HERMES_LIVE_ALLOW_ORIGIN`.
- Keep Hermes API Server private to the gateway network.
- Use TLS and edge rate limits for non-local clients.
- Keep all Hermes/provider credentials server-side.
- Use a same-origin authenticated relay for browser/community UIs.
- Keep `HERMES_LIVE_TRUST_CLIENT_IDENTITY=false` unless every client is trusted.
- Keep `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=false` unless you accept model-declared concurrency scopes as policy input.
- Put `HERMES_LIVE_TASK_STATE_FILE` in a private, backed-up, persistent location.
- Persist `/var/lib/hermes-live` when using Docker.
- Set session, task concurrency, queue, retention, and request-size limits intentionally.
- Disable the demo unless it is a deliberate production surface.
- Treat unknown task outcomes as potentially partially executed.
- Inspect logs and state backups for sensitive task content before sharing them.

For vulnerability reporting, see the repository-level [Security Policy](../SECURITY.md).
