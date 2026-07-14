# Hermes Plugin

`hermes-live-voice` is a Hermes plugin package that adds realtime voice access to Hermes Agent through a local gateway runtime.

The package/repository name is `hermes-live-voice`. The installed CLI command, Hermes plugin id, toolset, and slash command remain `hermes-live` so existing Hermes-facing names stay short and stable.

The plugin manifest version is kept identical to the npm package version and verified by `npm run check:plugin` before release.

The plugin and gateway have different jobs:

- The Hermes plugin gives Hermes installations a discoverable integration surface, status tool, slash command, and Dashboard tab.
- The gateway runtime owns WebSockets, audio frames, realtime provider sessions, client auth, and the browser demo.
- Hermes remains responsible for memory, tools, skills, MCP, approvals, terminal/file access, and long-running work.

This keeps the project Hermes-native without pushing a public audio server into Hermes core.

## What The Plugin Provides

The current plugin registers:

- `hermes_live_status` tool.
- `/hermes-live` slash command.
- Official Dashboard **Live Voice** tab with connection state, transcript, task activity, interruption, run stop, and capability-gated approval controls.
- Same-origin Dashboard status and WebSocket endpoints authenticated by Hermes.
- Server-side gateway credential injection so browser code never receives `HERMES_LIVE_AUTH_TOKEN`.
- Packaged shared browser client, microphone worklet, and styles.
- Gateway name and runtime mode.
- Default local gateway URL from `HERMES_LIVE_URL` or `http://127.0.0.1:8788`.
- WebSocket, readiness, and capabilities paths.

The network/audio gateway remains a separate runtime process. This keeps provider sockets and long-lived gateway credentials outside the Dashboard browser and outside Hermes core.

## Official Dashboard

After installing and enabling the plugin, start the companion gateway and restart the Dashboard:

```sh
hermes dashboard
```

Choose **Live Voice** from the plugin navigation group. The page checks readiness before connecting and then exposes:

- browser microphone and provider audio playback when the selected realtime provider supports them;
- text fallback for mock mode and inaccessible microphones;
- separate **Interrupt speech** and **Stop Hermes task** controls;
- sanitized task events and final output;
- negotiated approval status and, when Hermes supports targeted response IDs, explicit choices with a second confirmation for permanent inspectable patterns;
- responsive desktop and mobile layouts.

`HERMES_LIVE_URL` in the Dashboard process must be a credential-free HTTP(S) gateway origin, such as `http://127.0.0.1:8788`. It must not contain user information, query parameters, fragments, or an embedded bearer. Configure `HERMES_LIVE_AUTH_TOKEN` separately in the Dashboard process when the gateway requires it.

The browser opens a host-authenticated WebSocket to `/api/plugins/hermes-live/live`. The plugin backend reuses Hermes Dashboard authentication and origin policy before proxying to the gateway. It does not expose the upstream URL or token in `/status` responses.

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

Run the gateway from a GitHub clone:

```sh
npm ci
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_AGENT_API_SERVER_KEY=... HERMES_LIVE_PROVIDER=mock npm run dev
```

Or run the built CLI directly:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_AGENT_API_SERVER_KEY=... HERMES_LIVE_PROVIDER=mock node dist/cli.js serve
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
node dist/cli.js client "What should I work on next?"
```

For a persistent remote/headless session:

```sh
node dist/cli.js terminal
```

The terminal surface is text-control only. Use Hermes Ctrl+B Voice Mode for local terminal audio or the Dashboard/browser client for gateway audio.

## Boundary

The realtime provider does not receive Hermes tools directly. It receives gateway tools that start, stop, and inspect Hermes runs. Approval decisions are never provider tools: when Hermes advertises targeted approval identity, they come from the authenticated human client and are checked against the exact pending gateway envelope. An older uncorrelated approval request triggers deny/stop/session-close containment instead of an interactive decision. That boundary is what lets Hermes stay the brain while realtime providers handle voice and turn-taking.

## Install In Hermes

Current Hermes releases can clone the plugin subdirectory, install it under `~/.hermes/plugins/hermes-live/`, and enable it in one command:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --enable
```

For a local clone or npm package, copy or symlink the packaged plugin directory instead:

```sh
node dist/cli.js plugin install
hermes plugins enable hermes-live
```

Useful installer options:

```sh
node dist/cli.js plugin status
node dist/cli.js plugin path
node dist/cli.js plugin install --force
node dist/cli.js plugin install --symlink
node dist/cli.js plugin install --dir /custom/hermes/plugins
```

Project-local plugins can also be used under `.hermes/plugins/` when `HERMES_ENABLE_PROJECT_PLUGINS=true` is set for trusted repositories.

For custom and community web UIs, see [UI Integration](ui-integration.md). Generic OpenAI-compatible chat support does not implement the Hermes Live WebSocket/audio/run/approval protocol by itself.
