# Hermes Plugin

`hermes-live` is a Hermes plugin package that adds realtime voice access to Hermes Agent through a local gateway runtime.

The plugin and gateway have different jobs:

- The Hermes plugin gives Hermes installations a discoverable integration surface.
- The gateway runtime owns WebSockets, audio frames, realtime provider sessions, client auth, and the browser demo.
- Hermes remains responsible for memory, tools, skills, MCP, approvals, terminal/file access, and long-running work.

This keeps the project Hermes-native without pushing a public audio server into Hermes core.

## What The Plugin Provides

The current plugin metadata describes:

- Gateway name.
- Runtime mode.
- Default local gateway URL.
- WebSocket path.
- Capabilities path.

Future plugin work can add local launch helpers or Hermes-native voice tools, but the network/audio gateway should remain a separate runtime process.

## Runtime Usage

Run the gateway with npm:

```sh
npm install -g hermes-live
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_API_KEY=... HERMES_LIVE_PROVIDER=mock hermes-live serve
```

Or with Docker:

```sh
docker compose -f examples/docker-compose.yml up
```

Then connect clients to:

```txt
ws://localhost:8788/v1/live
```

For a terminal smoke test:

```sh
hermes-live client "What should I work on next?"
```

## Boundary

The realtime provider does not receive Hermes tools directly. It receives gateway tools that start, stop, inspect, and approve Hermes runs. That boundary is what lets Hermes stay the brain while realtime providers handle voice and turn-taking.
