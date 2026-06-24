# Hermes Plugin

`hermes-live` is a Hermes plugin package that adds realtime voice access to Hermes Agent through a local gateway runtime.

The plugin and gateway have different jobs:

- The Hermes plugin gives Hermes installations a discoverable integration surface, status tool, and slash command.
- The gateway runtime owns WebSockets, audio frames, realtime provider sessions, client auth, and the browser demo.
- Hermes remains responsible for memory, tools, skills, MCP, approvals, terminal/file access, and long-running work.

This keeps the project Hermes-native without pushing a public audio server into Hermes core.

## What The Plugin Provides

The current plugin registers:

- `hermes_live_status` tool.
- `/hermes-live` slash command.
- Gateway name and runtime mode.
- Default local gateway URL from `HERMES_LIVE_URL` or `http://127.0.0.1:8788`.
- WebSocket, readiness, and capabilities paths.

Future plugin work can add local launch helpers or Hermes-native voice tools, but the network/audio gateway should remain a separate runtime process.

## Hermes Tool

When the plugin is enabled in Hermes, the model can call:

```txt
hermes_live_status
```

Arguments:

- `probe`: call the gateway HTTP endpoints; defaults to `true`.
- `include_readiness`: also call `/ready`; defaults to `false`.
- `timeout_ms`: HTTP timeout between `100` and `10000`; defaults to `2000`.

The tool reads `HERMES_LIVE_URL` and `HERMES_LIVE_AUTH_TOKEN` from the Hermes process environment. It never returns the token value.

## Slash Command

Inside Hermes CLI or gateway sessions:

```txt
/hermes-live
/hermes-live ready
```

The `ready` argument includes the authenticated `/ready` probe when `HERMES_LIVE_AUTH_TOKEN` is configured.

## Runtime Usage

Run the gateway with npm:

```sh
npm install -g hermes-live
hermes-live plugin install
hermes plugins enable hermes-live
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_API_KEY=... HERMES_LIVE_PROVIDER=mock hermes-live serve
```

Or from a clone:

```sh
npm install
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_API_KEY=... HERMES_LIVE_PROVIDER=mock npm run dev
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

## Install In Hermes

Hermes discovers user plugins from `~/.hermes/plugins/<plugin-name>/`. Copy or symlink this directory there, then enable it:

```sh
hermes-live plugin install
hermes plugins enable hermes-live
```

Useful installer options:

```sh
hermes-live plugin status
hermes-live plugin path
hermes-live plugin install --force
hermes-live plugin install --symlink
hermes-live plugin install --dir /custom/hermes/plugins
```

Project-local plugins can also be used under `.hermes/plugins/` when `HERMES_ENABLE_PROJECT_PLUGINS=true` is set for trusted repositories.
