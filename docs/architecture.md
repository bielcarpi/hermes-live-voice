# Architecture

`hermes-live-voice` is a Hermes Agent plugin package with a realtime voice gateway runtime. It installs the `hermes-live` CLI and Hermes plugin.

It is not a replacement for Hermes. It deliberately gives the realtime model one narrow way to use Hermes: call gateway tools that start, stop, and inspect Hermes runs. Approval decisions stay on the authenticated human-client path.

## Components

```txt
Hermes Dashboard browser
  -> authenticated same-origin plugin WebSocket
  -> Hermes Dashboard plugin backend
  -> authenticated hermes-live gateway
  -> realtime provider + Hermes API Server

Custom browser/mobile/desktop client
  -> authenticated hermes-live WebSocket
  -> realtime provider + Hermes API Server
```

### Client

Voice clients capture microphone audio, encode frames as base64 PCM16, and send JSON messages to `/v1/live`. The gateway returns provider audio, transcript deltas, Hermes run events, approval requests, errors, and logs. The shared browser client provides the connection lifecycle, protocol validation, request IDs, bounded buffering, microphone worklet, and audio playback helpers used by the Hermes Dashboard integration and the bundled demo.

The terminal client is deliberately different: it keeps the same persistent session and control contract but sends and renders text only. Local terminal microphone use remains the responsibility of official Hermes Voice Mode.

Clients may be:

- A Hermes-focused web or mobile client.
- A **Live Voice** integration for Hermes Dashboard.
- A community web UI integration or the bundled web demo.
- A native desktop app.
- The text-control terminal client.

### Hermes Plugin

The plugin owns the Hermes-facing discovery surface:

- Gateway metadata.
- `hermes_live_status` tool registration.
- `/hermes-live` slash command.
- A Hermes Dashboard **Live Voice** tab supplied by this plugin.
- Dashboard-packaged browser client, microphone worklet, and styles.
- An authenticated same-origin HTTP/WebSocket proxy that keeps gateway credentials out of browser code.
- Default local gateway URL.
- WebSocket, readiness, and capability paths.

The plugin should remain small and Hermes-specific. It should not turn Hermes core into a public audio/WebSocket server.

### Gateway

The gateway owns:

- Client WebSocket sessions.
- Client authentication.
- Browser origin checks.
- Realtime provider connections.
- Hermes session key generation.
- Tool-call routing.
- Hermes run/event/approval/stop calls.
- Static demo serving.

### Dashboard Authentication Boundary

The Dashboard browser never receives `HERMES_LIVE_AUTH_TOKEN`. It authenticates to Hermes' own Dashboard, obtains a host-authorized same-origin WebSocket URL, and connects to the plugin backend. The backend revalidates Dashboard authentication and origin policy, then opens the upstream gateway socket with the installation credential server-side.

Custom/community web UIs should use the same shape: an authenticated same-origin WebSocket proxy or a backend-issued short-lived ticket. A static frontend that embeds the shared gateway bearer is suitable only for trusted local development.

The gateway code is organized as a small ports-and-adapters system:

| Layer | Path | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/*` | Client/server wire protocol and pure audio helpers. |
| Application | `src/application/live-gateway/*` | Voice-session orchestration, gateway tool policy, and ports. |
| Inbound adapters | `src/adapters/inbound/http/*` | HTTP endpoints, WebSocket upgrade/auth/origin checks, static demo serving, and WebSocket client adaptation. |
| Hermes outbound adapter | `src/adapters/outbound/hermes/*` | Hermes API Server JSON/SSE calls behind the `HermesRunsPort`. |
| Realtime outbound adapters | `src/adapters/outbound/realtime/*` | Gemini Live, OpenAI Realtime, and mock provider implementations behind the realtime model port. |

`LiveGatewaySession` is the core use case. It depends on `ClientConnectionPort`, `HermesRunsPort`, and `LiveModelAdapter`, not on raw `ws`, provider SDKs, or Hermes HTTP details.

### Realtime Provider

The provider owns:

- Speech input handling.
- Speech output.
- Realtime conversational flow.
- Interruption behavior.
- Deciding when to call a gateway tool.

Supported providers:

- Gemini Live through `@google/genai`.
- OpenAI Realtime through WebSocket.
- Mock provider for local text tests.

Provider credential tests are not part of the default CI gate. See [live-provider-testing.md](live-provider-testing.md) for the manual evidence required before calling a live deployment ready.

### Hermes

Hermes owns:

- Memory.
- Tools.
- Skills.
- MCP servers.
- Terminal/file operations.
- Long-running task state.
- Human approval policy.

The gateway depends on these Hermes API Server capabilities:

- `GET /v1/capabilities`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `POST /v1/runs/{run_id}/stop`
- `POST /v1/runs/{run_id}/approval`

## Why a Gateway Runtime

Realtime voice needs persistent sockets, audio frames, provider sessions, auth for app clients, barge-in handling, and latency-sensitive state. `hermes-live-voice` keeps those concerns in a gateway runtime while making the project installable and discoverable as a Hermes plugin.

## Tool Boundary

The realtime provider does not receive the full Hermes toolset directly.

It receives gateway tools:

- `start_hermes_run`
- `get_hermes_run_status`
- `stop_hermes_run`

The realtime provider cannot submit approvals. The gateway assigns every sanitized envelope a gateway-owned id, keeps envelopes in FIFO order, and accepts a human `approval.respond` only when its request id has not been reused and its run id, approval id, and choice match the queue head. Opaque requests are deny-only; session and permanent policy choices require an inspectable visible pattern. Mutating responses are idempotently cached, and an ambiguous Hermes approval outcome stops the run and closes the session. Bulk approval resolution is rejected in protocol v2.

This preserves the intended chain:

```txt
Realtime model = ears, mouth, turn-taking
Hermes = brain, memory, actions
Gateway = translator, session manager, safety boundary
```

### Current delegation model

In v0.3, `start_hermes_run` is synchronous from the realtime provider's perspective: its tool result returns after the Hermes SSE run reaches a terminal event. The Dashboard and connected clients still receive progress, approvals, and stop controls while that work runs, but the speech model cannot naturally hold a second provider-side conversation or call `get_hermes_run_status` during the outstanding tool call. Provider-authored transcript lines are therefore labeled **Live voice**, not Hermes. A future async run bridge will return the run id immediately and deliver bounded progress/completion notifications independently.

## Session Identity

The gateway derives a Hermes session key from:

- `HERMES_LIVE_SESSION_PREFIX`
- server-owned `HERMES_LIVE_PROFILE_ID`
- server-owned `HERMES_LIVE_USER_LABEL`

Example:

```txt
agent:main:hermes-live:profile:default:user:voice
```

Client `profileId` and `userLabel` values are ignored by default. A trusted-client deployment can explicitly set `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true`, but a shared gateway must not treat those client strings as authenticated user identity.

For OpenAI Realtime, the gateway also sends a hashed privacy-preserving safety identifier in the `OpenAI-Safety-Identifier` header.

The derived Hermes session key stays server-side. Clients receive the gateway session id, not the internal Hermes session key or Hermes base URL.

When the Hermes client is authenticated, the gateway sends the derived session key on run creation and follow-up run-scoped Hermes calls. This keeps start, event streaming, status, stop, and approval requests tied to the same server-side voice session without exposing that key to browser or mobile clients.

## Failure Model

The gateway should fail closed:

- No realtime credentials: refuse to start except in mock mode.
- Network-accessible gateway bind without gateway auth: refuse to start unless explicitly opted out.
- Hermes missing run features: refuse session startup.
- Invalid client frames: return `session.error`.
- Provider tool calls without response ids: fail before Hermes side effects.
- Invalid or oversized provider output: close the provider/client session before forwarding it.
- Slow client: terminate its WebSocket when bounded outbound buffering is exhausted.
- Stream ends without a terminal run event: request stop, mark ownership indeterminate, and close the voice session until terminal state can be re-established.
- Stop request accepted: emit `run.stopping`; retain run ownership until terminal SSE confirmation.
- Active or still-starting run on socket close: close the realtime provider immediately, capture any late run id, and issue a separately bounded Hermes stop.
