<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice — Keep talking. Hermes keeps working." width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Hermes already has the intelligence. Now it has a real-time voice.</strong><br>
  Talk naturally while Hermes works in the background.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  · <a href="docs/plugin.md">Dashboard plugin</a>
  · <a href="docs/ui-integration.md">Browser SDK</a>
  · <a href="docs/background-tasks.md">Background tasks</a>
  · <a href="docs/security.md">Security</a>
</p>

<p align="center">
  <a href="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/hermes-live-voice"><img alt="npm version" src="https://img.shields.io/npm/v/hermes-live-voice"></a>
  <a href="https://github.com/bielcarpi/hermes-live-voice/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/bielcarpi/hermes-live-voice?display_name=tag"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933">
</p>

Hermes Live Voice adds a continuous, interruptible voice layer to Hermes Agent. Start a new Hermes chat or resume one you already use, then ask Hermes to inspect a repository, run tests, research options, or prepare a release. The conversation stays open while the work runs, and Hermes reports back when each task is done.

> “Audit this repository and run the tests in the background. While they work, help me plan the release. Tell me when each one is done.”

Hermes still owns the intelligence and execution: its tools, memory, and skills do the work. This project supplies the real-time conversation, durable task supervision, and completion loop.

## Quick start

You need Node.js 20+, Hermes Agent with its API Server running, and a Gemini or OpenAI API key. Keep Hermes's `API_SERVER_KEY` in `~/.hermes/.env`; setup can reuse it without printing it.

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Choose **Live Voice** in Dashboard, pick a saved Hermes chat or start a new one, and connect. Setup asks which voice provider to use, verifies a real provider connection, installs and enables the plugin, and keeps the gateway running as a user service.

No clone, build, project `.env`, or second terminal is required. You can also open the local browser client at <http://127.0.0.1:8788> or use the terminal:

```sh
hermes-live terminal
hermes-live terminal --resume <sessionId>
```

If something is not ready, run:

```sh
hermes-live doctor
```

It checks Node, private config permissions, plugin/runtime version parity, Hermes capabilities, provider configuration, the managed service, and gateway readiness, then prints the exact fix. See [setup and service management](docs/setup.md) for noninteractive setup, mock mode, custom paths, and uninstalling the service.

## Pick a client

| Need | Client |
| --- | --- |
| Everyday voice use | Hermes Dashboard + the Live Voice plugin |
| A custom or community web UI | `hermes-live-voice/browser` behind an authenticated relay |
| SSH, accessibility, or headless control | `hermes-live terminal` |
| Gateway development | The bundled browser client |
| Simple local push-to-talk | [Hermes Voice Mode](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/voice-mode.md) |

The terminal shows transcripts, current tool activity, retained results, and unread notifications. `/tasks`, `/status`, `/result`, `/followup`, `/ack`, and `/stop` control background work; `/interrupt` stops current speech; `/quit` detaches without cancelling tasks.

Generic OpenAI-compatible chat UIs need an adapter. Realtime audio and protocol v4 task events are not chat-completions traffic. The [UI integration guide](docs/ui-integration.md) covers Hermes WebUI and custom clients.

## How it works

![Hermes Live Voice architecture: clients talk to a realtime session while a durable supervisor manages Hermes Agent runs](assets/architecture.svg)

1. A Dashboard, browser, or terminal client opens the authenticated WebSocket and selects a persisted Hermes chat. Gemini Live or OpenAI Realtime handles speech, turn-taking, and interruption; canonical chat turns go through Hermes Sessions Chat so memory and history stay intact.
2. Meaningful work moves to a separate plane. The gateway persists a task before returning its receipt, then a server-side supervisor starts and watches the matching Hermes `/v1/runs` worker.
3. Sanitized tool activity reaches clients while work runs. Results become unread notifications, survive voice disconnects, and can start durable follow-up tasks with explicit parent/root lineage.

Voice and task cancellation stay separate. Interrupting speech does not stop work, and stopping one task never guesses at another task ID.

Task state defaults to `~/.hermes/hermes-live/tasks-v1.json`. The store is bounded, private, and single-writer. Docker deployments mount it on a dedicated volume.

## Use the browser client

```sh
npm install hermes-live-voice
```

```js
import { HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  webSocketUrlProvider: () => getAuthenticatedSameOriginUrl(),
  conversation: { mode: "resume", sessionId: savedHermesSessionId },
});

client.on("task.notification", renderNotification);
await client.connect();
client.sendText("Audit this repository while we plan the release.");
client.followUpTask(taskId, "Fix the issue you found, then rerun the tests.");
```

The dependency-free client includes protocol validation, microphone capture, bounded audio playback, reconnect reconciliation, and task controls. Do not put an installation-wide gateway token in public browser code; use a same-origin authenticated proxy or short-lived ticket.

## Limits worth knowing

- Client or provider disconnects do not cancel accepted tasks. Gateway restarts can reconcile them when the state file is preserved and the same Hermes Agent process still knows the upstream run.
- A canonical saved-chat turn is one synchronous Hermes answer. Long or independent work should be delegated as a background task so speech stays available; this split is intentional.
- Task follow-ups are new durable workers seeded with the selected finished task's retained result. They preserve lineage, not a hidden live subprocess or the original worker's full tool-call stack.
- Current Hermes runs do not survive a Hermes Agent restart. A missing or ambiguous outcome becomes `unknown`; Hermes Live never invents success or repeats a possibly accepted mutation.
- Work runs exclusively by default. Read-only parallelism is available only when the operator explicitly trusts model-declared read-only scopes with `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true`.
- Hermes approvals do not yet carry enough identity for safe per-request approval from this gateway. Approval-requiring tasks are denied and stopped fail-closed.
- The task inbox is durable; spoken completion notices are best effort. The current Gemini Live model/API path is itself a provider preview and should be tested against your account before deployment.
- The local file store is for one gateway process, not a multi-node queue or public multi-tenant service.

Read [background tasks](docs/background-tasks.md) for recovery details and [architecture](docs/architecture.md) for the trust boundary.

## Deploy safely

`hermes-live setup` writes only supported keys to `~/.hermes/hermes-live/config.env` with private permissions. Environment variables override it. The gateway never loads a project `.env` or executes config as shell code. For containers and source deployments, use [.env.example](.env.example) and the hardened [Docker Compose example](examples/docker-compose.yml).

For any non-loopback bind, set a strong `HERMES_LIVE_AUTH_TOKEN`, exact `HERMES_LIVE_ALLOW_ORIGIN`, TLS, and edge rate limits. Keep Hermes itself private. This package is self-hosted infrastructure, not turnkey public multi-tenancy. Review [the security model](docs/security.md) and report vulnerabilities through [GitHub private reporting](https://github.com/bielcarpi/hermes-live-voice/security/advisories/new).

## Documentation

- [Setup and service](docs/setup.md) — one-command activation, diagnostics, and lifecycle controls
- [Local and Docker setup](docs/local-setup.md) — source builds, providers, Dashboard, terminal, and Docker
- [Dashboard plugin](docs/plugin.md) — install, relay, and Hermes integration
- [Background tasks](docs/background-tasks.md) — scheduling, persistence, recovery, and notifications
- [Client protocol](docs/client-protocol.md) — protocol v4 wire contract
- [Live provider testing](docs/live-provider-testing.md) — real account and audio checks
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md)

## License

[MIT](LICENSE). Hermes Live Voice is a community project and is not an official NousResearch distribution. Hermes Agent, Gemini, OpenAI, and other product names belong to their respective owners.
