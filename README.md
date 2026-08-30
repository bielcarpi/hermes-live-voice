<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice — Keep talking. Hermes keeps working." width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Keep talking while Hermes does real work.</strong><br>
  Continuous realtime voice for saved chats, background runs, live progress, and reconnect-safe completion notices.
</p>

<p align="center">
  <a href="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/hermes-live-voice"><img alt="npm version" src="https://img.shields.io/npm/v/hermes-live-voice"></a>
  <a href="https://github.com/bielcarpi/hermes-live-voice/releases"><img alt="release" src="https://img.shields.io/github/v/release/bielcarpi/hermes-live-voice?display_name=tag"></a>
  <a href="https://github.com/bielcarpi/hermes-live-voice/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/bielcarpi/hermes-live-voice?style=flat"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a"></a>
</p>

Hermes Live Voice is a self-hosted realtime voice gateway and Dashboard plugin for [Hermes Agent](https://github.com/NousResearch/hermes-agent).

It supports long voice workflows: start a task, keep talking, disconnect, reconnect, and still receive the result.

Hermes remains the agent brain: model routing, tools, memory, skills, and execution stay in Hermes. The realtime provider handles speech and turn-taking. Hermes Live Voice owns the gateway, task supervision, progress stream, and client protocol.

<p align="center">
  <img src="assets/live-voice-dashboard.jpg" alt="Hermes Live Voice running as a connected tab inside the native Hermes Dashboard" width="100%">
  <br>
  <sub>Native Hermes Dashboard v0.20.6 with the bundled plugin connected in local mock mode.</sub>
</p>

## Quick start

You need Hermes Agent 0.18.2 or newer and Node.js 20+. Local voice on Apple Silicon also needs [uv](https://docs.astral.sh/uv/).

```sh
npm install --global hermes-live-voice
hermes-live setup --provider openai
hermes-live launch-check
hermes dashboard
```

Open **Live Voice**. Choose a new or saved chat. Select **Connect**. The microphone starts automatically. Say "pause listening" to pause. Use the microphone button to resume.

| Provider | Best for | Setup |
| --- | --- | --- |
| OpenAI Realtime | Fast hosted setup | `hermes-live setup --provider openai` |
| Gemini Live | Google or Vertex deployments | `hermes-live setup --provider gemini` |
| Local Hugging Face | Private local voice on Apple Silicon | `hermes-live setup --provider local --service` |

`hermes-live setup` installs the Hermes Dashboard plugin and the companion gateway. `launch-check` rejects mock mode and proves the complete path through one bounded Hermes worker.

Deterministic fixtures cover Hermes Agent 0.20.0 (`v2026.8.3`). Scheduled CI also checks the current Hermes image. See [Setup](docs/setup.md) for local voice requirements, remote endpoints, and Docker.

## What it does

- Continuous microphone mode with voice activity detection and barge-in
- New or resumed Hermes chats with their existing memory and history
- Background work that continues through voice disconnects
- Live, sanitized task progress and tool activity
- Parallel read-only work when the operator explicitly enables it
- Spoken completion notices and a persistent task inbox
- Dashboard, browser SDK, and headless terminal clients

Try:

> Audit this repository and run the tests in the background. While that runs, help me plan the release. Tell me when it is done.

The voice conversation stays responsive while a server-side supervisor owns the Hermes run. Interrupting speech never stops a task. Stopping a task always targets its exact task ID.

See the [text-only workflow transcript](examples/live-workflow-transcript.md) for the expected task handoff, progress, reconnect, and completion flow.

## How it works

![Hermes Live Voice architecture](assets/architecture.svg)

1. The Dashboard, browser SDK, or terminal opens the authenticated protocol v6 WebSocket and selects a Hermes conversation.
2. Local speech-to-speech, Gemini Live, or OpenAI Realtime handles the live voice turn and can call the gateway's small task-control toolset.
3. The gateway persists accepted work, starts a separate Hermes `/v1/runs` worker, and publishes bounded progress events.
4. Results remain in the task inbox across reconnects. Follow-ups create new workers with explicit parent/root lineage.

Task state lives at `~/.hermes/hermes-live/tasks-v1.json` by default. It is bounded, private, and single-writer.

## Clients

| Use | Client |
| --- | --- |
| Everyday voice | Hermes Dashboard → Live Voice |
| SSH or headless control | `hermes-live terminal` |
| Host app integration | `hermes-live-voice/browser` |

The terminal can resume chats and inspect or control tasks:

```sh
hermes-live terminal --resume <sessionId>
```

Commands include `/tasks`, `/status`, `/result`, `/followup`, `/ack`, `/stop`, and `/interrupt`. `/quit` detaches. It does not cancel work.

Browser integration is dependency-free:

```js
import { HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  webSocketUrlProvider: () => getAuthenticatedSameOriginUrl(),
  conversation: { mode: "resume", sessionId: savedSessionId },
});

client.on("task.notification", renderNotification);
await client.connect();
```

See [UI integration](docs/ui-integration.md) for authentication and the full client lifecycle.

## Operations

```sh
hermes-live launch-check
hermes-live doctor --provider-smoke
hermes-live diagnostics
hermes-live service status
hermes-live service logs
hermes-live local status
hermes-live local logs
hermes-live print-config
```

After updating the npm package, run `hermes-live upgrade`. It reinstalls the matching plugin and service definitions without replacing your provider settings. Run `hermes-live launch-check` after the upgrade. `hermes-live diagnostics` writes a private support bundle without logs, prompts, task results, audio, or secret values.

`hermes-live setup` writes an allow-listed config to `$HERMES_HOME/hermes-live/config.env` (normally `~/.hermes/hermes-live/config.env`) with private permissions. The gateway and Dashboard plugin read the same file. If the default port belongs to another app, setup picks a free local port automatically. Environment variables override the managed config. Project `.env` files are never loaded or executed.

For any non-loopback gateway bind, use a strong `HERMES_LIVE_AUTH_TOKEN`, an exact allowed origin, TLS, and edge rate limits. Keep Hermes itself private. See the [security model](docs/security.md).

## Current boundaries

- Durability applies to task receipts, state, notifications, and retained results. In-progress Hermes runs do not survive a Hermes Agent restart. Missing or ambiguous outcomes become `unknown`.
- Work is exclusive by default. Parallelism requires `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true` because model-declared read-only scope is policy input, not a sandbox.
- Approval-required tasks are denied and stopped fail-closed until Hermes exposes exact targeted approval identity to the gateway.
- One delegated task creates one Hermes run. Hermes Live does not create a subagent team for every request.
- The local launcher is currently managed on Apple Silicon. Other systems can run the upstream realtime server and set `HERMES_LIVE_LOCAL_URL`.
- The local file store is for one gateway process, not a public multi-tenant or multi-node queue.
- This repository does not ship a standalone web app. Browser voice runs in the Hermes Dashboard plugin or a host app that uses the browser SDK.

## Documentation

- [Setup, configuration, and Docker](docs/setup.md)
- [Architecture](docs/architecture.md)
- [Background tasks and recovery](docs/background-tasks.md)
- [Protocol v6](docs/client-protocol.md)
- [UI integration](docs/ui-integration.md)
- [Security](docs/security.md)
- [Live provider testing](docs/live-provider-testing.md)
- [Roadmap](docs/roadmap.md)
- [Release process](docs/releasing.md)
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md)

## License

[MIT](LICENSE). This is a community project, not an official NousResearch distribution.
