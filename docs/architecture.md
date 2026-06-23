# Architecture

`hermes-live` is a realtime voice sidecar for Hermes Agent.

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

- Saturday mobile app.
- A web demo.
- A native desktop app.
- A terminal/WebSocket test client.

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

## Why a Sidecar First

Realtime voice is a network runtime more than a Hermes extension. It needs persistent sockets, audio frames, provider sessions, auth for app clients, barge-in handling, and latency-sensitive state. Those concerns are cleaner outside Hermes core.

The optional plugin exists for discovery and convenience, not because the gateway has to be a plugin.

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

## Failure Model

The gateway should fail closed:

- No realtime credentials: refuse to start except in mock mode.
- Network-accessible gateway bind without gateway auth: refuse to start unless explicitly opted out.
- Hermes missing run features: refuse session startup.
- Invalid client frames: return `session.error`.
- Stream ends without terminal run event: return `run.failed`.
- Active run on socket close: request Hermes stop.
