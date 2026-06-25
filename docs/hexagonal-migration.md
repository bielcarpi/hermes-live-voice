# Hexagonal Migration Plan

`hermes-live-voice` should use the useful part of the Onyze-style ports-and-adapters shape: clear boundaries without heavyweight ceremony.

The target is not abstract enterprise DDD. The target is a gateway whose core session orchestration does not depend on WebSocket, HTTP, provider SDK, or Hermes HTTP details.

## Original Mapping

| Responsibility | Original files | Original issue |
| --- | --- | --- |
| Inbound HTTP/WebSocket | `src/server/http.ts`, `src/server/static.ts` | Mostly isolated, but it constructs sessions with raw `ws` sockets. |
| Application use case | `src/session/live-session.ts` | Owns Hermes/provider orchestration, but also parses raw frames and writes JSON to WebSocket directly. |
| Realtime provider port | `src/realtime/live.ts` | Already a good port, but named by transport instead of use-case boundary. |
| Realtime provider adapters | `src/gemini/live.ts`, `src/openai/realtime.ts`, `src/gemini/mock.ts` | Good adapters, but not grouped as outbound adapters. |
| Hermes outbound adapter | `src/hermes/client.ts`, `src/hermes/sse.ts` | Good adapter, but no explicit application-facing port. |
| Domain/protocol | `src/protocol.ts`, `src/audio/pcm.ts` | Protocol concerns are mixed: client wire messages, server messages, provider events, and tool declarations. |
| Runtime/CLI | `src/cli.ts`, `src/config.ts`, `src/readiness.ts` | Acceptable, but imports will need to follow the new boundaries. |

## Implemented Shape

```txt
src/domain/
  audio/
  protocol/

src/application/live-gateway/
  live-gateway-session.ts
  system-instruction.ts
  tool-definitions.ts
  ports/
    client-connection.port.ts
    hermes-runs.port.ts
    realtime-model.port.ts

src/adapters/inbound/http/
  server.ts
  static.ts
  websocket-client-connection.ts

src/adapters/outbound/hermes/
  hermes-runs.client.ts
  sse.ts

src/adapters/outbound/realtime/
  factory.ts
  gemini-live.adapter.ts
  mock-live.adapter.ts
  openai-realtime.adapter.ts

src/config.ts
src/cli.ts
src/readiness.ts
```

## Boundary Rules

- `domain/*` contains pure validation, parsing, audio normalization, and wire types. It does not import adapters.
- `application/live-gateway/*` contains session orchestration and gateway tool policy. It depends on ports, not concrete `ws`, Gemini, OpenAI, or Hermes HTTP clients.
- `adapters/inbound/*` owns HTTP/WebSocket transport, auth, CORS/origin checks, and static demo serving.
- `adapters/outbound/hermes/*` owns Hermes API Server HTTP/SSE details.
- `adapters/outbound/realtime/*` owns provider SDK/WebSocket details.
- `src/index.ts` keeps public package exports stable for users even as internals move.

## Execution Slices

1. Document the target and keep the behavior unchanged.
2. Move pure protocol/audio/realtime abstractions behind domain/application names.
3. Add explicit ports for Hermes runs, realtime model sessions, and client connections.
4. Move outbound Hermes and realtime providers under `adapters/outbound`.
5. Move inbound HTTP/WebSocket code under `adapters/inbound`.
6. Refactor `LiveGatewaySession` to depend on `ClientConnectionPort` instead of `ws`.
7. Update tests, docs, package smoke expectations, and exports.
8. Run full verification and inspect package contents before completion.

## Non-Goals

- No database, queue, or persistence layer.
- No fake repository pattern.
- No new framework.
- No behavioral changes to the client protocol, Hermes API calls, plugin install path, or provider selection.
- No breaking public package exports unless explicitly planned for a later major version.

## Completion Evidence

The migration is complete only when:

- `LiveGatewaySession` has no `ws` import and receives a client connection port.
- `HermesClient` implements an application-facing Hermes runs port.
- Gemini, OpenAI, and mock providers live under outbound realtime adapters.
- HTTP/WebSocket server code lives under inbound adapters.
- The README and architecture docs describe the new layout.
- `npm run verify` passes.
- `npm pack --dry-run --json --silent` shows the expected adapter/domain/application files in the package.
