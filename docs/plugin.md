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
- Hermes Dashboard **Live Voice** tab with connection state, transcript, task activity, interruption, run stop, and capability-gated approval controls.
- Same-origin Dashboard status and WebSocket endpoints authenticated by Hermes.
- Server-side gateway credential injection so browser code never receives `HERMES_LIVE_AUTH_TOKEN`.
- Packaged shared browser client, microphone worklet, and styles.
- Gateway name and runtime mode.
- Default local gateway URL from `HERMES_LIVE_URL` or `http://127.0.0.1:8788`.
- WebSocket, readiness, and capabilities paths.

The network/audio gateway remains a separate runtime process. This keeps provider sockets and long-lived gateway credentials outside the Dashboard browser and outside Hermes core.

## Hermes Dashboard

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

The Dashboard status backend does not follow redirects and accepts only bounded JSON responses. The WebSocket proxy also rejects handshake redirects, so it never replays the installation bearer to a redirect target. It reports ready only after validating the Hermes Live capabilities object, service identity, and protocol version and confirming that the gateway, Hermes, and realtime readiness checks are all explicitly healthy. It omits any allowlisted capability string that reflects the configured gateway bearer.

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

`HERMES_LIVE_URL` must be a credential-free `http://` or `https://` origin. A path, query, fragment, embedded username/password, unsupported scheme, malformed port, or surrounding whitespace makes the tool fail before it sends a request or echoes the configured value. Keep the bearer only in `HERMES_LIVE_AUTH_TOKEN`; unsafe whitespace/control characters and values larger than 8 KiB are rejected before probing.

Gateway probes do not follow redirects. Each response must be JSON and is read through a 16 KiB limit; larger, non-JSON, malformed, or endpoint-incompatible responses fail with a stable error code. The tool returns only bounded, endpoint-specific status/capability/readiness fields. Allowed string fields are still omitted if they contain control characters or reflect the configured bearer, including as part of a longer value. The tool does not relay raw response bodies, upstream error text, readiness base URLs, or unknown fields into the Hermes model context.

## Slash Command

Inside Hermes CLI or gateway sessions:

```txt
/hermes-live
/hermes-live ready
```

The `ready` argument includes the authenticated `/ready` probe when `HERMES_LIVE_AUTH_TOKEN` is configured.

## Runtime Usage

Install the package and its matching Hermes plugin:

```sh
npm install --global hermes-live-voice
hermes-live plugin install --force
hermes plugins enable hermes-live
```

Start the installed gateway:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_AGENT_API_SERVER_KEY=... HERMES_LIVE_PROVIDER=mock hermes-live serve
```

For source development, run from a GitHub clone instead:

```sh
npm ci
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
HERMES_BASE_URL=http://127.0.0.1:8642 HERMES_AGENT_API_SERVER_KEY=... HERMES_LIVE_PROVIDER=mock npm run dev
```

Or with Docker:

```sh
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_AUTH_TOKEN=your-random-gateway-token \
docker compose -f examples/docker-compose.yml up --build
```

Both variables are required by the Compose example. Put them in a protected env file and pass `--env-file` instead of shell history for a persistent deployment.

Then connect clients to:

```txt
ws://localhost:8788/v1/live
```

The commands below assume the globally installed package. From a built source checkout, replace `hermes-live` with `node dist/cli.js`.

For a terminal smoke test:

```sh
hermes-live client "What should I work on next?"
```

For a persistent remote/headless session:

```sh
hermes-live terminal
```

The terminal surface is text-control only, but it still opens a realtime-provider session and can incur provider usage. Use Hermes Voice Mode or Desktop for first-party local audio, and the Dashboard/browser client for gateway audio.

## Boundary

The realtime provider does not receive Hermes tools directly. It receives gateway tools that start, stop, and inspect Hermes runs. Approval decisions are never provider tools: when Hermes advertises targeted approval identity, they come from the authenticated human client and are checked against the exact pending gateway envelope. An older uncorrelated approval request triggers deny/stop/session-close containment instead of an interactive decision. That boundary is what lets Hermes stay the brain while realtime providers handle voice and turn-taking.

## Install In Hermes

The npm package can install its bundled plugin under `~/.hermes/plugins/hermes-live/`:

```sh
hermes-live plugin install --force
hermes plugins enable hermes-live
```

For bleeding-edge development only, Hermes can install the latest plugin source directly from the repository default branch:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --enable
```

That syntax shallow-clones unpinned `main`; it does not install the npm gateway CLI and cannot guarantee plugin/runtime version parity. Prefer `hermes-live plugin install --force` for normal use. If you test latest source, run the gateway from the same checkout.

Useful installer options:

```sh
hermes-live plugin status
hermes-live plugin path
hermes-live plugin install --force
hermes-live plugin install --symlink
hermes-live plugin install --dir /custom/hermes/plugins
```

Project-local plugins can also be used under `.hermes/plugins/` when `HERMES_ENABLE_PROJECT_PLUGINS=true` is set for trusted repositories.

For custom and community web UIs, see [UI Integration](ui-integration.md). Generic OpenAI-compatible chat support does not implement the Hermes Live WebSocket/audio/run/approval protocol by itself.
