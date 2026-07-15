<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice — Talk to Hermes like a live call" width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Talk to Hermes like a live call.</strong>
</p>

<p align="center">
  The open-source realtime voice layer for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>.<br>
  Gemini Live or OpenAI Realtime handles natural conversation and interruption;<br>
  Hermes keeps the memory, tools, skills, and work.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  · <a href="#why-not-just-use-hermes-voice-mode">Why this exists</a>
  · <a href="docs/plugin.md">Plugin</a>
  · <a href="docs/ui-integration.md">UI integration</a>
  · <a href="docs/client-protocol.md">Client protocol</a>
  · <a href="docs/architecture.md">Architecture</a>
  · <a href="docs/roadmap.md">Roadmap</a>
</p>

<p align="center">
  <a href="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/bielcarpi/hermes-live-voice/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/bielcarpi/hermes-live-voice/releases"><img alt="Release" src="https://img.shields.io/github/v/release/bielcarpi/hermes-live-voice?display_name=tag"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-16a34a"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <img alt="Status: developer preview" src="https://img.shields.io/badge/status-developer%20preview-f59e0b">
</p>

<p align="center">
  <img src="assets/dashboard-live-voice.jpg" alt="Hermes Live Voice running inside Hermes Dashboard in deterministic mock mode" width="100%">
  <br>
  <sub>Hermes Dashboard integration shown in safe mock mode; Gemini and OpenAI modes support microphone input and audio playback.</sub>
</p>

## Give Your Hermes Agent A Realtime Voice

Hermes Live Voice is a Hermes plugin, a self-hosted voice gateway, and a small client protocol. It turns an existing Hermes Agent into the action-taking brain behind an interruptible speech-to-speech conversation.

Ask it to inspect a repository, use memory, research something current, or run a command. The realtime model handles the speech loop; Hermes performs the tool-using work, while clients keep progress and stop controls visible.

### What you get

- **Natural realtime speech** with persistent sessions, interruption, and separate controls for provider playback and Hermes work.
- **The Hermes you already configured** with its memory, terminal access, skills, MCP servers, and model setup.
- **A first-class Dashboard experience** with microphone and playback, transcripts, task progress, stop controls, and negotiated safety status.
- **Browser, custom UI, and terminal surfaces** backed by one authenticated JSON/WebSocket gateway.
- **Gemini Live and OpenAI Realtime**, plus a deterministic mock provider for setup and CI.
- **A narrow security boundary**: the realtime model gets only three gateway tools—not Hermes credentials, session keys, or approval authority. Provider credentials stay server-side and out of client and tool payloads.

Try a request that makes the agent do real work: *“Inspect this repository, run the tests, and tell me whether it is safe to release.”*

> **Approval safety:** Hermes Agent v0.18.2, tested for this release, does not expose stable approval IDs. Hermes Live Voice never guesses: it attempts denial, stops the run, and closes the voice session. Interactive decisions enable only after Hermes negotiates targeted approval identity. See the [security model](docs/security.md).

## Why Not Just Use Hermes Voice Mode?

Hermes includes an excellent built-in [Voice Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/voice-mode/) for speaking directly with the Hermes CLI. Start there when you want the shortest local path.

Use Hermes Live Voice when the product itself needs a persistent realtime conversation or a custom client:

| | Hermes Voice Mode | Hermes Live Voice |
| --- | --- | --- |
| Best for | Speaking with the Hermes CLI | Building browser, mobile, desktop, or device voice clients |
| Voice architecture | Hermes-managed speech pipeline | Persistent provider speech-to-speech session |
| Interruption | CLI voice interaction | Client-controlled barge-in, playback truncation, and run stop |
| Client protocol | Built into Hermes | Public JSON/WebSocket protocol |
| Providers | Hermes voice configuration | Gemini Live, OpenAI Realtime, or mock |
| Agent actions | Hermes | Hermes, through three gateway tools |
| Deployment shape | Local Hermes feature | Separate self-hosted gateway and optional Hermes plugin |

## Choose How You Use It

| Surface | Best for | Audio |
| --- | --- | --- |
| **Hermes Dashboard + Live Voice — recommended** | Daily use with transcript, progress, interruption, stop, and negotiated safety status | Browser microphone and playback |
| **Bundled browser demo** | Local development and gateway troubleshooting | Browser microphone and playback |
| **`hermes-live-voice/browser`** | Community web UIs and custom React, Vue, Svelte, vanilla, or Electron clients | Host-integrated microphone and playback |
| **`hermes-live terminal`** | SSH, headless systems, automation, and remote text control | Text only |
| **Hermes Ctrl+B Voice Mode** | The fastest local terminal voice experience | Hermes-managed voice |

An OpenAI-compatible chat endpoint alone does not provide this realtime audio and run-event contract. Community UIs should follow the [UI integration guide](docs/ui-integration.md).

## Quick Start

### Prerequisites

- Node.js 20 or newer.
- A running [Hermes Agent API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) with its `API_SERVER_KEY` configured.
- A Gemini or OpenAI key for real speech. No provider key is needed for mock mode.

### 1. Install and build

Until the first npm publication, install from GitHub:

```sh
git clone --branch v0.3.1 --depth 1 https://github.com/bielcarpi/hermes-live-voice.git
cd hermes-live-voice
npm ci
npm run build
```

### 2. Install the Hermes plugin

Install the plugin from the tagged checkout you just built:

```sh
node dist/cli.js plugin install --force
hermes plugins enable hermes-live
```

`--force` replaces an older installed copy so the gateway and plugin stay on the same release. The repository/package name is `hermes-live-voice`; the short CLI command and plugin id are `hermes-live`. See [plugin installation](docs/plugin.md#install-in-hermes) for the one-line latest-source option and symlinked development installs.

### 3. Start safely in mock mode

Use the same value for `HERMES_AGENT_API_SERVER_KEY` that Hermes uses for `API_SERVER_KEY`:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_PROVIDER=mock \
npm run dev
```

Start or restart Hermes Dashboard after enabling the plugin:

```sh
hermes dashboard
```

Open **Live Voice**, connect, and send a text message. Mock mode verifies the Dashboard proxy, gateway, client protocol, and Hermes run bridge without spending realtime-provider credits. It intentionally disables microphone input and audio output.

The standalone development UI remains available at <http://127.0.0.1:8788>. Use it when developing the gateway or debugging an installation without the Dashboard.

### 4. Turn on live speech

Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=your-gemini-key \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
npm run dev
```

OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai \
OPENAI_API_KEY=your-openai-key \
OPENAI_REALTIME_MODEL=gpt-realtime-2.1 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
npm run dev
```

Before calling a real-provider deployment ready, repeat the provider selection and credential in a second shell for an actual connect/close smoke test:

```sh
HERMES_LIVE_PROVIDER=gemini GEMINI_API_KEY=your-gemini-key npm run check:live-provider
# or
HERMES_LIVE_PROVIDER=openai OPENAI_API_KEY=your-openai-key npm run check:live-provider
```

Then complete the audio and negative-case checklist in [live provider testing](docs/live-provider-testing.md).

## Use It From A Terminal

For local terminal microphone use, run `hermes` and press **Ctrl+B**. For a remote gateway, automation host, or headless machine, use the persistent text-control console:

```sh
HERMES_LIVE_URL=https://voice.example.com \
HERMES_LIVE_AUTH_TOKEN=your-gateway-token \
node dist/cli.js terminal
```

The console shows transcripts and Hermes progress, with separate `/interrupt` and `/stop` controls. It is intentionally text-only; use the Dashboard or browser client for gateway audio. Scripts can use `node dist/cli.js client "What is the current status?"`. See [UI integration](docs/ui-integration.md#terminal).

## Supported Providers

| Provider | Default model | Notes |
| --- | --- | --- |
| Gemini Live | `gemini-3.1-flash-live-preview` | Uses the Google Gen AI SDK. Vertex/Enterprise configuration is supported. |
| OpenAI Realtime | `gpt-realtime-2.1` | Server-side WebSocket integration with speech, tool calls, VAD or push-to-talk, and reasoning effort. |
| Mock | `mock-live` | Text-only local development and deterministic CI. |

Model ids are configuration, not hardcoded provider forks. Override `GEMINI_MODEL` or `OPENAI_REALTIME_MODEL` when validating a compatible model.

## How It Works

```mermaid
flowchart LR
  C["Voice client<br/>browser · mobile · desktop · device"]
  G["Hermes Live Voice<br/>auth · sessions · audio · policy"]
  R["Realtime provider<br/>Gemini Live or OpenAI Realtime"]
  H["Hermes Agent<br/>memory · tools · skills · MCP"]

  C <-->|"JSON + PCM16 over WebSocket"| G
  G <-->|"persistent realtime session"| R
  R -->|"3 gateway tool calls"| G
  G <-->|"Runs API + SSE"| H
```

The realtime model is the **ears, mouth, and turn-taking layer**. Hermes is the **brain and action layer**. The gateway is the **translator and security boundary**.

The provider can ask the gateway to:

- `start_hermes_run`
- `get_hermes_run_status`
- `stop_hermes_run`

It cannot call arbitrary Hermes tools or submit approvals. Human choices come only from an authenticated client and must match the negotiated identity; legacy uncorrelated requests trigger the fail-closed containment described above.

In v0.3 the realtime provider waits for a delegated Hermes run to finish, while clients continue receiving progress and stop controls. Continuous provider-side conversation during that work remains a [roadmap](docs/roadmap.md) item.

Read the [architecture](docs/architecture.md) and [client protocol](docs/client-protocol.md) for the full lifecycle.

## Configuration

The gateway reads the process environment. npm scripts do **not** load a local `.env` automatically, so export variables or pass them inline as shown in Quick Start. Docker Compose can consume one explicitly with `--env-file`.

At minimum, set `HERMES_AGENT_API_SERVER_KEY` to Hermes Agent's `API_SERVER_KEY`, then select `mock` or provide the chosen realtime-provider credential. [.env.example](.env.example) is the complete reference; [local setup](docs/local-setup.md) explains every runtime path.

A network-accessible bind requires a strong `HERMES_LIVE_AUTH_TOKEN` and should use an exact `HERMES_LIVE_ALLOW_ORIGIN`. This developer preview is not a turnkey public multi-user service; review the [deployment security model](docs/security.md) before exposing it beyond localhost.

## Build A Custom UI

Until npm publishing is enabled, install the exact GitHub release tarball:

```sh
npm install https://github.com/bielcarpi/hermes-live-voice/releases/download/v0.3.1/hermes-live-voice-0.3.1.tgz
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
npm run dev                       # run the gateway from source
npm run build                     # compile the distributable CLI/library
node dist/cli.js client "..."     # one-shot text client
node dist/cli.js terminal         # persistent text-control console
node dist/cli.js chat             # alias for terminal
node dist/cli.js check            # gateway + Hermes + provider config
node dist/cli.js provider-smoke   # real provider connect/close test
node dist/cli.js plugin install   # install the Hermes plugin
node dist/cli.js plugin status    # inspect the plugin installation
npm run verify                    # complete local release gate
```

Docker users can start from [examples/docker-compose.yml](examples/docker-compose.yml). It binds to host loopback and runs read-only, capability-free, and non-root by default. Use an authenticated TLS proxy for remote access.

## Security And Maturity

Hermes Live Voice is a **developer preview for self-hosted, trusted-client use**. Long-lived credentials stay server-side; network binds and ambiguous approvals fail closed. Before remote exposure, add TLS, a high-entropy auth token, an exact origin allowlist, edge rate and cost limits, and keep Hermes/provider endpoints private. Review [the security model](docs/security.md) and [vulnerability reporting policy](SECURITY.md).

The release gate covers 354 tests plus type, docs, browser, Dashboard, plugin, CLI, gateway, package, dependency, CodeQL, and Docker checks. v0.3.1 was also exercised against the official Hermes v0.18.2 image and a real Gemini Live connection.

What deterministic CI does **not** prove:

- valid external provider credentials or model entitlement;
- real microphone and speaker behavior;
- provider latency or cost under load;
- public multi-user safety;
- long-duration session reliability.

See [live-provider testing](docs/live-provider-testing.md) and the [roadmap](docs/roadmap.md). Never paste secrets into an issue; report vulnerabilities privately through [SECURITY.md](SECURITY.md).

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
