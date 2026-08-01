<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice — Keep talking. Hermes keeps working." width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Real-time voice for Hermes Agent.</strong><br>
  Keep talking while Hermes works in the background.
</p>

<p align="center">
  <a href="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/hermes-live-voice"><img alt="npm version" src="https://img.shields.io/npm/v/hermes-live-voice"></a>
  <a href="https://github.com/bielcarpi/hermes-live-voice/releases"><img alt="release" src="https://img.shields.io/github/v/release/bielcarpi/hermes-live-voice?display_name=tag"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a"></a>
</p>

Hermes Live Voice is a continuous, interruptible voice layer for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Open a saved Hermes chat, delegate work, keep the conversation going, ask what each task is doing, and hear when it finishes.

Hermes still supplies the model, tools, memory, and skills. This project adds the live conversation, durable task supervision, and Dashboard UI.

## Quick start

You need Node.js 20+ and Hermes Agent's API Server running.

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Open **Live Voice** in the Dashboard and choose a new or saved chat. Setup installs and enables the plugin, verifies Hermes and your voice provider, and keeps the gateway running as a user service.

For fully local voice on Apple Silicon, start the tested [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech) stack first:

```sh
# Terminal 1 — local STT, LLM, and TTS
hermes-live local

# Terminal 2
hermes-live setup --provider local
hermes dashboard
```

The first local start downloads Python packages and model weights. Gemini Live and OpenAI Realtime remain available from the same setup prompt.

## What it does

- Continuous microphone mode with voice activity detection and barge-in
- New or resumed Hermes chats with their existing memory and history
- Durable background tasks that survive voice disconnects
- Live, sanitized task progress and tool activity
- Parallel read-only work when the operator explicitly enables it
- Spoken completion notices plus a persistent task inbox
- Dashboard, browser SDK, and headless terminal clients

Try:

> Audit this repository and run the tests in the background. While that runs, help me plan the release. Tell me when it is done.

The voice conversation stays responsive while a server-side supervisor owns the Hermes run. Interrupting speech never stops a task; stopping a task always targets its exact task ID.

## How it works

![Hermes Live Voice architecture](assets/architecture.svg)

1. The Dashboard, browser SDK, or terminal opens the authenticated protocol v5 WebSocket and selects a Hermes conversation.
2. Local speech-to-speech, Gemini Live, or OpenAI Realtime handles the live voice turn and can call the gateway's small task-control toolset.
3. The gateway persists accepted work, starts a separate Hermes `/v1/runs` worker, and publishes bounded progress events.
4. Results remain in the task inbox across reconnects. Follow-ups create new durable workers with explicit parent/root lineage.

Task state lives at `~/.hermes/hermes-live/tasks-v1.json` by default. It is bounded, private, and single-writer.

## Clients

| Use | Client |
| --- | --- |
| Everyday voice | Hermes Dashboard → Live Voice |
| SSH or headless control | `hermes-live terminal` |
| Your own web UI | `hermes-live-voice/browser` |
| Gateway development | `http://127.0.0.1:8788` |

The terminal can resume chats and inspect or control tasks:

```sh
hermes-live terminal --resume <sessionId>
```

Commands include `/tasks`, `/status`, `/result`, `/followup`, `/ack`, `/stop`, and `/interrupt`. `/quit` detaches; it does not cancel work.

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
hermes-live doctor --provider-smoke
hermes-live service status
hermes-live service logs
hermes-live print-config
```

`hermes-live setup` writes an allow-listed config to `~/.hermes/hermes-live/config.env` with private permissions. Environment variables override it; project `.env` files are never loaded or executed.

For any non-loopback gateway bind, use a strong `HERMES_LIVE_AUTH_TOKEN`, an exact allowed origin, TLS, and edge rate limits. Keep Hermes itself private. See the [security model](docs/security.md).

## Current boundaries

- Hermes runs do not survive a Hermes Agent restart. Missing or ambiguous outcomes become `unknown`; the gateway never guesses success or repeats a possibly accepted mutation.
- Work is exclusive by default. Parallelism requires `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true` because model-declared read-only scope is policy input, not a sandbox.
- The local launcher is currently managed on Apple Silicon. Other systems can run the upstream realtime server and set `HERMES_LIVE_LOCAL_URL`.
- The local file store is for one gateway process, not a public multi-tenant or multi-node queue.

## Documentation

- [Setup, configuration, and Docker](docs/setup.md)
- [Background tasks and recovery](docs/background-tasks.md)
- [Architecture](docs/architecture.md)
- [Protocol v5](docs/client-protocol.md)
- [Security](docs/security.md)
- [Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md)

## License

[MIT](LICENSE). This is a community project, not an official NousResearch distribution.
