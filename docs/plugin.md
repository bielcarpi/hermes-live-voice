# Hermes Plugin

The npm package is `hermes-live-voice`; the CLI, Hermes plugin id, status tool, and slash command use the shorter name `hermes-live`. The plugin and package versions are kept identical and verified before release.

The plugin makes Hermes Live discoverable inside Hermes and adds the Dashboard UI. The companion gateway remains a separate process because it owns long-lived provider sockets, audio frames, client authentication, and durable task supervision.

## What It Provides

- `hermes_live_status` tool;
- `/hermes-live` slash command;
- Hermes Dashboard **Live Voice** tab;
- same-origin Dashboard status and WebSocket routes authenticated by Hermes;
- server-side gateway credential injection;
- packaged browser client, microphone worklet, and styles;
- gateway URL, readiness, capabilities, and WebSocket metadata.

The Dashboard tab supports browser voice, text fallback, transcript, speech interruption, durable task inbox, exact task stop, reconnect snapshots, unread completion notices, and retained results. Protocol v3 has no approval controls; approval-requiring tasks are denied and stopped by the gateway.

## Install The Published Plugin

The normal path installs, enables, verifies, and starts everything:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Choose **Live Voice** in the plugin navigation group.

Setup installs the exact plugin bundled with the CLI, reuses Hermes's existing `API_SERVER_KEY` when available, verifies required Hermes capabilities and a real voice-provider session, and installs a user service. Run `hermes-live doctor` for exact remediation.

Useful installer commands:

```sh
hermes-live plugin status
hermes-live plugin path
hermes-live plugin install --force
hermes-live plugin install --symlink
hermes-live plugin install --dir /custom/hermes/plugins
```

These lower-level commands are mainly for source development and custom layouts. See [Setup and service management](setup.md) for automation and lifecycle commands.

Project-local plugins under `.hermes/plugins/` require `HERMES_ENABLE_PROJECT_PLUGINS=true` and should be enabled only for trusted repositories.

## Source Development

```sh
npm ci
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
HERMES_AGENT_API_SERVER_KEY=... HERMES_LIVE_PROVIDER=mock npm run dev
```

Hermes can also install the latest plugin source directly:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --enable
```

That command shallow-clones unpinned `main`; it does not install the gateway CLI and cannot guarantee plugin/runtime version parity. Prefer the npm package for normal use. When testing latest source, run both plugin and gateway from the same commit.

## Dashboard Relay

The browser connects only to same-origin Hermes routes:

```txt
Dashboard browser
  -> Hermes-authenticated /api/plugins/hermes-live/live
  -> plugin_api.py
  -> Authorization: Bearer HERMES_LIVE_AUTH_TOKEN
  -> gateway /v1/live
```

Configure the Dashboard server process when the gateway is remote or authenticated:

```sh
HERMES_LIVE_URL=https://voice.example.com
HERMES_LIVE_AUTH_TOKEN=your-high-entropy-gateway-token
```

`HERMES_LIVE_URL` must be a credential-free HTTP(S) origin. User information, paths, query parameters, fragments, WS(S) schemes, and surrounding whitespace are rejected. The token is separate and never returned to the browser.

The backend reuses Hermes Dashboard authentication and origin policy. It rejects redirects, enforces bounded timeouts/message sizes, validates service identity and protocol version, and reports ready only when gateway, Hermes, and realtime configuration are healthy.

## Status Tool

When enabled, Hermes can call:

```txt
hermes_live_status
```

Arguments:

- `probe`: call the gateway endpoints; default `true`;
- `include_readiness`: also call authenticated `/ready`; default `false`;
- `timeout_ms`: bounded from 100 to 10,000; default 2,000.

The tool reads `HERMES_LIVE_URL` and `HERMES_LIVE_AUTH_TOKEN` from the Hermes process environment. It never returns the token.

Probes reject redirects, require bounded JSON, and return only endpoint-specific allowlisted fields. They do not relay raw bodies, upstream errors, readiness base URLs, unknown fields, control characters, or values reflecting the configured bearer into Hermes model context.

## Slash Command

Inside Hermes:

```txt
/hermes-live
/hermes-live ready
```

`ready` includes the authenticated readiness probe when the gateway token is configured.

## Runtime And Clients

The default gateway endpoint is:

```txt
ws://127.0.0.1:8788/v1/live
```

Terminal smoke:

```sh
hermes-live client "Inspect this repository"
```

Persistent text control:

```sh
hermes-live terminal
```

The terminal is text-only but exposes the same durable inbox, reconnect, exact result, speech interruption, and exact task-stop contract. It still opens a realtime-provider session and can incur provider usage. Use Hermes Voice Mode or Desktop for first-party local audio, and the Dashboard/browser client for gateway audio.

Docker:

```sh
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_AUTH_TOKEN=your-high-entropy-gateway-token \
docker compose -f examples/docker-compose.yml up --build
```

The Compose example persists task state in `hermes-live-state`; keep that volume across gateway restarts.

## Trust Boundary

The realtime provider receives four narrow gateway tools that start, list, inspect, and stop owner-scoped tasks. It does not receive Hermes tools, credentials, raw events, upstream run ids, or approval authority. Hermes remains responsible for memory, tools, skills, MCP, and execution; the gateway supervises lifetime, persistence, scheduling, and client projection.

Closing Dashboard or the provider session detaches from tasks. Only an exact `task.stop` cancels work. If Hermes requests approval, the supervisor attempts deny-all and stops that task fail-closed; the plugin has no approval control.

For custom/community clients, see [UI Integration](ui-integration.md). Generic OpenAI-compatible chat support does not implement the Hermes Live protocol v3 audio/task/notification contract by itself.
