<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice — Talk to Hermes like a live call" width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Hermes already has the brain. Give it a realtime voice.</strong><br>
  Talk naturally. Watch Hermes work. Stay in control.
</p>

<p align="center">
  The self-hosted realtime voice gateway and client SDK for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>.<br>
  Gemini Live or OpenAI Realtime handles speech and interruption;<br>
  Hermes keeps the memory, tools, skills, and work.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  · <a href="#choose-your-voice-path">Why this exists</a>
  · <a href="docs/plugin.md">Plugin</a>
  · <a href="docs/ui-integration.md">UI integration</a>
  · <a href="docs/client-protocol.md">Client protocol</a>
  · <a href="docs/architecture.md">Architecture</a>
  · <a href="docs/roadmap.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/hermes-live-voice"><img alt="npm version" src="https://img.shields.io/npm/v/hermes-live-voice"></a>
  <a href="https://github.com/bielcarpi/hermes-live-voice/releases"><img alt="Release" src="https://img.shields.io/github/v/release/bielcarpi/hermes-live-voice?display_name=tag"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <img alt="Status: developer preview" src="https://img.shields.io/badge/status-developer%20preview-f59e0b">
</p>

<p align="center">
  <img src="assets/dashboard-live-voice.jpg" alt="Hermes Live Voice running inside Hermes Dashboard in deterministic mock mode" width="100%">
  <br>
  <sub>Type, watch Hermes work, and stop the task in deterministic mock mode; live providers add microphone, playback, and speech interruption.</sub>
</p>

## Give your Hermes Agent a realtime voice

Hermes Live Voice is a Hermes plugin, a self-hosted voice gateway, and a small client protocol. It turns an existing Hermes Agent into the action-taking brain behind an interruptible speech-to-speech conversation—without giving the speech provider direct access to Hermes's memory store, credentials, or tool APIs.

Speak naturally, interrupt provider playback, watch Hermes work, and stop a long-running task from the Dashboard, a custom client, or a remote terminal. The realtime model handles the speech loop; Hermes performs the tool-using work.

### What you get

- **Action-taking realtime speech** through a long-lived provider session while connected, with interruption and separate controls for provider playback and Hermes work.
- **The Hermes you already configured** with its memory, terminal access, skills, MCP servers, and model setup.
- **A polished Hermes Dashboard plugin experience** with microphone and playback, provider-emitted transcripts, task lifecycle, stop controls, and negotiated safety status.
- **Browser, custom UI, and terminal surfaces** backed by one auth-capable JSON/WebSocket gateway.
- **Gemini Live and OpenAI Realtime**, plus a deterministic mock provider for setup and CI.
- **A narrow provider-facing boundary**: the realtime model gets only three gateway tools—not Hermes credentials, session keys, or approval authority. Delegated runs still use the tools and policies configured in Hermes.

It earns its keep when voice is more than dictation: a hands-free research or coding session, an operations task whose progress must stay visible and cancellable, or a community app that needs Hermes behind its own realtime UI. Try: *“Inspect this repository, run the tests, and tell me whether it is safe to release.”*

> **Current preview limitation:** while Hermes executes a delegated task, provider conversation pauses until the run finishes. Clients still receive the sanitized task lifecycle and can stop the task.

> **Approval safety:** The most recently integration-tested Hermes Agent version, v0.18.2, does not expose stable approval IDs. Hermes Live Voice never guesses: it attempts denial, stops the run, and closes the voice session. Interactive decisions enable only after Hermes negotiates targeted approval identity. See the [security model](docs/security.md).

## Choose Your Voice Path

Hermes includes an excellent built-in [Voice Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode/) for its CLI/TUI, messaging voice replies, and Discord voice channels; Hermes Desktop also has its own voice surface. Start there when an official Hermes client already fits the job.

Use Hermes Live Voice when you need a long-lived realtime provider connection, a custom client, and a public task-control protocol:

| Need | Best path | What it gives you |
| --- | --- | --- |
| First-party local or messaging voice | **Hermes Voice Mode or Desktop** | The shortest supported path inside Hermes |
| Daily browser voice | **Hermes Dashboard + Live Voice — recommended** | Microphone, playback, provider transcripts, task lifecycle, interrupt, and stop |
| A custom or community web app | **`hermes-live-voice/browser` + backend relay** | Framework-independent audio/client SDK without browser-side installation credentials |
| Gateway development or troubleshooting | **Bundled browser demo** | A direct local protocol and audio test surface |
| SSH, accessibility, or remote diagnostics | **`hermes-live terminal`** | Persistent text control with transcript, task state, `/interrupt`, and `/stop` |

The Dashboard tab is supplied by this community plugin; it is not bundled with Hermes Agent. Hermes WebUI and Open WebUI need explicit adapters today, and an OpenAI-compatible chat connection alone is not plug-and-play. See [community UI compatibility](docs/ui-integration.md#community-ui-compatibility).

## Quick Start

### Prerequisites

- Node.js 20 or newer.
- A running [Hermes Agent API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) with its `API_SERVER_KEY` configured.
- A Gemini or OpenAI key for real speech. No provider key is needed for mock mode.

If the Hermes API Server is not already enabled, add these values to `~/.hermes/.env`, then keep the foreground gateway running:

```sh
API_SERVER_ENABLED=true
API_SERVER_KEY=your-hermes-api-server-key

hermes gateway run
```

### 1. Install

```sh
npm install --global hermes-live-voice
hermes-live --version
```

### 2. Install the Hermes plugin

Install the matching packaged plugin:

```sh
hermes-live plugin install --force
hermes plugins enable hermes-live
```

`--force` replaces an older installed copy so the gateway and plugin stay on the same release. The repository/package name is `hermes-live-voice`; the short CLI command and plugin id are `hermes-live`. See [plugin installation](docs/plugin.md#install-in-hermes) for development alternatives.

### 3. Start safely in mock mode

Use the same value for `HERMES_AGENT_API_SERVER_KEY` that Hermes uses for `API_SERVER_KEY`:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_PROVIDER=mock \
hermes-live serve
```

Start or restart Hermes Dashboard after enabling the plugin:

```sh
hermes dashboard
```

Open **Live Voice**, connect, and send a text message. Mock mode verifies the Dashboard proxy, gateway, client protocol, and Hermes run bridge without spending realtime-provider credits. It intentionally disables microphone input and audio output.

The bundled browser demo remains available at <http://127.0.0.1:8788>. Use it when developing the gateway or debugging an installation without the Dashboard.

### 4. Turn on live speech

Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=your-gemini-key \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
hermes-live serve
```

OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai \
OPENAI_API_KEY=your-openai-key \
OPENAI_REALTIME_MODEL=gpt-realtime-2.1 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
hermes-live serve
```

Before calling a real-provider deployment ready, run `hermes-live provider-smoke` with the same provider and credential, then complete the audio and negative-case checklist in [live provider testing](docs/live-provider-testing.md). The smoke command proves only a provider connect/close handshake—not audio or tool use.

## Use It From A Terminal

For the official local terminal microphone path, run `hermes` and use Voice Mode. For a remote or headless gateway, use the persistent text-control console:

```sh
HERMES_LIVE_URL=https://voice.example.com \
HERMES_LIVE_AUTH_TOKEN=your-gateway-token \
hermes-live terminal
```

The console shows transcripts and sanitized Hermes task state, with separate `/interrupt` and `/stop` controls. It is intentionally text-only, but it still opens a realtime-provider session and can incur provider usage. Treat it as interactive remote control or a diagnostic/accessibility fallback, not deterministic automation. Use `hermes-live client "What is the current status?"` for a one-shot smoke test. See [UI integration](docs/ui-integration.md#terminal).

## Supported Providers

| Provider | Default model | Notes |
| --- | --- | --- |
| Gemini Live | [`gemini-3.1-flash-live-preview`](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview) | Uses the Google Gen AI SDK. Vertex/Enterprise configuration is supported. |
| OpenAI Realtime | [`gpt-realtime-2.1`](https://developers.openai.com/api/docs/models/gpt-realtime-2.1) | Server-side WebSocket integration with speech, tool calls, VAD or push-to-talk, and reasoning effort. Assistant transcripts are surfaced; separate spoken-input transcription is not enabled. |
| Mock | `mock-live` | Text-only local development and deterministic CI. |

Model ids are configuration, not hardcoded provider forks. Override `GEMINI_MODEL` or `OPENAI_REALTIME_MODEL` when validating a compatible model.

## How It Works

![Hermes Live Voice architecture: a client connects to the gateway, which keeps separate realtime-provider and Hermes Agent connections](assets/architecture.svg)

The realtime model is the **ears, mouth, and turn-taking layer**. Hermes is the **brain and action layer**. The gateway is the **translator and security boundary**.

The provider can ask the gateway to:

- `start_hermes_run`
- `get_hermes_run_status`
- `stop_hermes_run`

It cannot call arbitrary Hermes tools directly or submit approvals. A delegated Hermes run can use whatever tools and policies that Hermes installation already exposes. Human choices come only from an authenticated client and must match the negotiated identity; legacy uncorrelated requests trigger the fail-closed containment described above.

Currently, the realtime provider waits for a delegated Hermes run to finish, while clients continue receiving progress and stop controls. Continuous provider-side conversation during that work remains a [roadmap](docs/roadmap.md) item.

Read the [architecture](docs/architecture.md) and [client protocol](docs/client-protocol.md) for the full lifecycle.

## Configuration

The gateway reads the process environment and does **not** load a local `.env` automatically, so export variables or pass them inline as shown in Quick Start. Docker Compose can consume one explicitly with `--env-file`.

At minimum, set `HERMES_AGENT_API_SERVER_KEY` to Hermes Agent's `API_SERVER_KEY`, then select `mock` or provide the chosen realtime-provider credential. [.env.example](.env.example) is the primary deployment template; [plugin usage](docs/plugin.md#runtime-usage) covers packaged operation and [local setup](docs/local-setup.md) covers checkout development.

A network-accessible bind requires a strong `HERMES_LIVE_AUTH_TOKEN` and should use an exact `HERMES_LIVE_ALLOW_ORIGIN`. This developer preview is not a turnkey public multi-user service; review the [deployment security model](docs/security.md) before exposing it beyond localhost.

## Build A Custom UI

```sh
npm install hermes-live-voice
```

The dependency-free browser client is the same one used by the Hermes Dashboard integration and bundled demo:

```js
import { HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  webSocketUrlProvider: () => getAuthenticatedWebSocketUrl(),
});

client.on("run.completed", ({ output }) => showResult(output));
await client.connect();
client.sendText("Inspect this repository and summarize what changed.");
```

The client also provides microphone capture, bounded playback, interruption, request IDs, lifecycle validation, and state subscriptions. A browser host must return a same-origin authenticated proxy URL or a short-lived ticket—never embed the installation-wide gateway token in public code. See [UI integration](docs/ui-integration.md) and the versioned [client protocol](docs/client-protocol.md).

## Commands

```sh
hermes-live serve                 # start the gateway and bundled demo
hermes-live client "..."          # one-shot text client
hermes-live terminal              # persistent text-control console
hermes-live chat                  # alias for terminal
hermes-live check                 # gateway + Hermes + provider config
hermes-live provider-smoke        # real provider connect/close test
hermes-live plugin install        # install the Hermes plugin
hermes-live plugin status         # inspect the plugin installation
```

Contributors working from a repository checkout can use `npm run dev`, `npm run build`, and `npm run verify`; see [local setup](docs/local-setup.md) and [contributing](CONTRIBUTING.md).

From a repository checkout, Docker users can start from [examples/docker-compose.yml](examples/docker-compose.yml). It binds to host loopback and runs read-only, capability-free, and non-root by default. Use an authenticated TLS proxy for remote access.

## Security And Maturity

Hermes Live Voice is a **developer preview for self-hosted, trusted-client use**. Long-lived credentials stay server-side; network binds and ambiguous approvals fail closed. Before remote exposure, add TLS, a high-entropy auth token, an exact origin allowlist, edge rate and cost limits, and keep Hermes/provider endpoints private. Review [the security model](docs/security.md) and [vulnerability reporting policy](SECURITY.md).

The selected realtime provider receives user audio/text and the bounded final Hermes response returned to the voice session; that response can contain information Hermes obtained from memory, files, or tools. Credentials, Hermes session keys, and raw tool APIs stay server-side, but content does not magically stay local. Do not ask Hermes to return data the selected provider should not receive.

Clients share a server-owned Hermes profile/user scope by default. This is not per-user authentication or a turnkey multi-tenant service; keep the default identity policy unless every client is trusted and independently authenticated.

The release gate covers 350+ tests plus type, docs, browser, Dashboard, plugin, CLI, gateway, package, dependency, CodeQL, and Docker checks. Deterministic CI does not prove real credentials, microphone/speaker behavior, provider latency or cost, public multi-user safety, or long-session reliability. Exact Hermes/provider evidence lives in the [UI integration matrix](docs/ui-integration.md#hermes-dashboard), [live-provider checklist](docs/live-provider-testing.md), and release notes. Never paste secrets into an issue; report vulnerabilities privately through [SECURITY.md](SECURITY.md).

## Contributing

Focused contributions are welcome—especially client SDKs, safe structured progress narration, provider event fixtures, reconnect behavior, accessibility, and real-world deployment evidence.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Keep provider changes isolated, include tests, and avoid vendoring unrelated speech frameworks or rebranding the project inside a feature PR.

[Contribution guide](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Discussions](https://github.com/bielcarpi/hermes-live-voice/discussions) · [Security policy](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE). Hermes Live Voice is community-maintained and is not an official NousResearch distribution. Hermes Agent, Gemini, and OpenAI are separate projects and services governed by their own licenses and terms.

---

<p align="center">
  <strong>Hermes already has the brain. Give it a realtime voice.</strong>
</p>
