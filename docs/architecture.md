# Architecture

`hermes-live` is a Hermes Agent plugin package with a realtime voice gateway runtime.

It is not a replacement for Hermes. It deliberately gives the realtime model one narrow way to use Hermes: call gateway tools that start, stop, inspect, and approve Hermes runs.

## Components

```txt
Browser/mobile/desktop client
  -> hermes-live WebSocket
  -> realtime provider session
  -> provider tool call
  -> Hermes API Server
  -> Hermes memory/tools/skills/MCP
```

### Client

The client captures microphone audio, encodes frames as base64 PCM16, and sends JSON messages to `/v1/live`. The gateway returns provider audio, transcript deltas, Hermes run events, approval requests, errors, and logs.

Clients may be:

- A Hermes-focused web or mobile client.
- A web demo.
- A native desktop app.
- A terminal/WebSocket test client.

### Hermes Plugin

The plugin owns the Hermes-facing discovery surface:

- Gateway metadata.
- `hermes_live_status` tool registration.
- `/hermes-live` slash command.
- Default local gateway URL.
- WebSocket, readiness, and capability paths.
- Future local launch helpers.
- Future Hermes-native voice tools.

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

Realtime voice needs persistent sockets, audio frames, provider sessions, auth for app clients, barge-in handling, and latency-sensitive state. `hermes-live` keeps those concerns in a gateway runtime while making the project installable and discoverable as a Hermes plugin.

## Tool Boundary

The realtime provider does not receive the full Hermes toolset directly.

It receives gateway tools:

- `start_hermes_run`
- `get_hermes_run_status`
- `stop_hermes_run`
- `submit_hermes_approval`

This preserves the intended chain:

```txt
Realtime model = ears, mouth, turn-taking
Hermes = brain, memory, actions
Gateway = translator, session manager, safety boundary
```

## Session Identity

The gateway derives a Hermes session key from:

- `HERMES_LIVE_SESSION_PREFIX`
- `profileId`
- `userLabel`

Example:

```txt
agent:main:hermes-live:profile:default:user:alice
```

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
- Stream ends without terminal run event: return `run.failed`.
- Active run on socket close: request Hermes stop.
