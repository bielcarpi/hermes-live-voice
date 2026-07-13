<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice — Talk to Hermes like a live call" width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Talk to Hermes like a live call.</strong>
</p>

<p align="center">
  An open-source realtime speech bridge for <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>.<br>
  Gemini Live or OpenAI Realtime handles natural conversation and interruption;<br>
  Hermes keeps the memory, tools, skills, approvals, and work.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  · <a href="#why-not-just-use-hermes-voice-mode">Why this exists</a>
  · <a href="docs/plugin.md">Plugin</a>
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

## Give Your Hermes Agent A Realtime Voice

Hermes Live Voice is a Hermes plugin, a self-hosted voice gateway, and a small client protocol. It turns an existing Hermes Agent into the action-taking brain behind an interruptible speech-to-speech conversation.

Ask it to inspect a repository, use memory, research something current, run a command, or request an approval. The realtime model keeps the conversation fluid while Hermes performs the actual work.

```txt
You speak
   ↓
Gemini Live or OpenAI Realtime
   ↓  delegates meaningful work
Hermes Live Voice gateway
   ↓
Hermes Agent — memory, tools, skills, MCP, approvals
   ↓
The result returns to the live conversation
```

The realtime provider receives four narrow gateway tools—not unrestricted access to the Hermes toolbelt. Provider credentials, Hermes credentials, and Hermes session keys remain on the server.

### What you get

- **Natural realtime conversation** — persistent speech sessions instead of record, transcribe, wait, and synthesize loops.
- **Barge-in and cancellation** — interrupt provider speech and stop an active Hermes run.
- **The Hermes you already configured** — keep its memory, terminal access, skills, MCP servers, approval policy, and model setup.
- **Two live providers** — Gemini Live and OpenAI Realtime, plus a deterministic mock provider for local development.
- **A client-ready gateway** — connect a browser, mobile app, desktop app, embedded device, or terminal client over WebSocket.
- **Human approvals** — surface Hermes approval requests and send the decision back to the same run.
- **A real Hermes plugin** — install `hermes-live`, check gateway status from Hermes, and keep voice integration discoverable.

## See The Difference

The useful demo is not a chatbot greeting. It is a live request that makes Hermes work:

> “Inspect this repository, run the tests, and tell me whether it is safe to release.”

A good client can acknowledge immediately, let the user interrupt, show Hermes run progress, surface an approval, cancel when asked, and speak the final result.

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
| Agent actions | Hermes | Hermes, through four gateway tools |
| Deployment shape | Local Hermes feature | Separate self-hosted gateway and optional Hermes plugin |

This project does not replace Hermes Voice Mode. It serves the integration layer that Voice Mode is not designed to be.

## Quick Start

### Prerequisites

- Node.js 20 or newer.
- A running [Hermes Agent API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/) with its `API_SERVER_KEY` configured.
- A Gemini or OpenAI key for real speech. No provider key is needed for mock mode.

### 1. Install and build

Until the first npm publication, install from GitHub:

```sh
git clone https://github.com/bielcarpi/hermes-live-voice.git
cd hermes-live-voice
npm ci
npm run build
```

### 2. Install the Hermes plugin

Current Hermes releases can install and enable the plugin directly from this repository:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --enable
```

If you already cloned and built the gateway, the package installer provides the same plugin locally:

```sh
node dist/cli.js plugin install
hermes plugins enable hermes-live
```

The repository/package name is `hermes-live-voice`. The short CLI command and Hermes plugin id are `hermes-live`.

### 3. Start safely in mock mode

Use the same value for `HERMES_AGENT_API_SERVER_KEY` that Hermes uses for `API_SERVER_KEY`:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_PROVIDER=mock \
npm run dev
```

Open <http://127.0.0.1:8788>, connect, and send a text message. Mock mode verifies the gateway, plugin-facing runtime, client protocol, and Hermes run bridge without spending realtime-provider credits.

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

Before calling a real-provider deployment ready, open an actual provider session:

```sh
npm run check:live-provider
```

Then complete the audio, interruption, approval, and negative-case checklist in [docs/live-provider-testing.md](docs/live-provider-testing.md).

## Supported Providers

| Provider | Default model | Notes |
| --- | --- | --- |
| Gemini Live | `gemini-3.1-flash-live-preview` | Uses the Google Gen AI SDK. Vertex/Enterprise configuration is supported. |
| OpenAI Realtime | `gpt-realtime-2.1` | Server-side WebSocket integration with speech, tool calls, VAD or push-to-talk, and reasoning effort. |
| Mock | `mock-live` | Text-only local development and deterministic CI. |

Model ids are configuration, not hardcoded provider forks. Override `GEMINI_MODEL` or `OPENAI_REALTIME_MODEL` when validating a compatible model.

### About future `gpt-live-1` support

`gpt-live-1` is not currently listed in OpenAI's public API documentation or model catalog. It cannot be selected or truthfully advertised as supported today.

The project is designed to adopt new OpenAI live models without changing the Hermes boundary. If `gpt-live-1` becomes a public Realtime-compatible API model, the plan is to add captured event fixtures, tool-call coverage, interruption tests, and a real provider handshake before listing it as supported. See the [compatibility roadmap](docs/roadmap.md#provider-roadmap).

Current OpenAI model guidance is tracked against the official [Realtime and audio documentation](https://developers.openai.com/api/docs/guides/realtime), not rumors or private product labels.

## How It Works

```mermaid
flowchart LR
  C["Voice client<br/>browser · mobile · desktop · device"]
  G["Hermes Live Voice<br/>auth · sessions · audio · policy"]
  R["Realtime provider<br/>Gemini Live or OpenAI Realtime"]
  H["Hermes Agent<br/>memory · tools · skills · MCP · approvals"]

  C <-->|"JSON + PCM16 over WebSocket"| G
  G <-->|"persistent realtime session"| R
  R -->|"4 gateway tool calls"| G
  G <-->|"Runs API + SSE"| H
```

The realtime model is the **ears, mouth, and turn-taking layer**. Hermes is the **brain and action layer**. The gateway is the **translator and security boundary**.

The provider can ask the gateway to:

- `start_hermes_run`
- `get_hermes_run_status`
- `stop_hermes_run`
- `submit_hermes_approval`

It cannot call arbitrary Hermes tools directly.

Read the [architecture](docs/architecture.md) and [client protocol](docs/client-protocol.md) for the full lifecycle.

## Configuration

Copy the example and change only what you need:

```sh
cp .env.example .env
```

### Hermes

```sh
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_AGENT_API_SERVER_KEY=...
```

`HERMES_AGENT_API_SERVER_KEY` must equal Hermes Agent's `API_SERVER_KEY`. The older `HERMES_API_KEY` name remains a compatibility alias.

### Public or LAN gateway

```sh
HERMES_LIVE_HOST=0.0.0.0
HERMES_LIVE_AUTH_TOKEN=$(openssl rand -hex 32)
HERMES_LIVE_ALLOW_ORIGIN=https://voice.example.com
HERMES_LIVE_DEMO_ENABLED=false
```

The gateway refuses a network-accessible bind without a strong auth token unless you explicitly set the unsafe `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` opt-out.

This release is intended for a self-hosted, trusted-user installation. A shared bearer token is not multi-tenant identity. Do not expose the gateway as a public multi-user SaaS without adding per-user authentication, quotas, rate limits, and an identity-to-Hermes-profile policy.

### OpenAI

```sh
HERMES_LIVE_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
OPENAI_REALTIME_VOICE=marin
OPENAI_REALTIME_REASONING_EFFORT=low
OPENAI_REALTIME_TURN_DETECTION=disabled
```

Use `semantic_vad` or `server_vad` for provider-managed turn detection. `disabled` gives clients an explicit push-to-talk style `audio.end` boundary.

### Gemini

```sh
HERMES_LIVE_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.1-flash-live-preview
```

Vertex/Enterprise users can set `GOOGLE_GENAI_USE_ENTERPRISE=true`, `GOOGLE_CLOUD_PROJECT`, and `GOOGLE_CLOUD_LOCATION`.

The complete configuration is documented in [.env.example](.env.example) and [docs/local-setup.md](docs/local-setup.md).

## Client Protocol

Connect to:

```txt
ws://127.0.0.1:8788/v1/live
```

Start a session:

```json
{
  "type": "session.start",
  "protocolVersion": 1,
  "profileId": "default",
  "userLabel": "alice"
}
```

Send text for a smoke test:

```json
{
  "type": "text.input",
  "text": "Inspect this repository and summarize what changed."
}
```

Or stream base64 PCM16 audio frames and end the turn with `audio.end`. The server emits provider audio/transcripts, Hermes run events, approvals, completion, and typed errors.

The package also exposes a dependency-free browser client used by the bundled demo:

```js
import { HermesLiveAudio, HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  url: "wss://voice.example.com/v1/live",
  token: () => getShortLivedToken(),
});
const audio = new HermesLiveAudio(client, {
  workletUrl: "/mic-worklet.js",
});

client.on("approval.request", showApproval);
client.on("run.completed", ({ output }) => showResult(output));
await client.connect();
await audio.startMicrophone();
```

The gateway serves the canonical worklet at `/mic-worklet.js`; package consumers can also resolve the `hermes-live-voice/browser/mic-worklet.js` export into their own static assets. The client validates lifecycle messages, returns request IDs, bounds microphone and playback buffering, and exposes `subscribe()`/`getSnapshot()` for React or other state-driven UIs. It accepts an async `webSocketUrlProvider`, so a host can mint short-lived same-origin WebSocket tickets without exposing a persistent gateway credential.

See [docs/client-protocol.md](docs/client-protocol.md) before building a client.

## Commands

```sh
npm run dev                       # run the gateway from source
npm run build                     # compile the distributable CLI/library
node dist/cli.js client "..."     # one-shot text client
node dist/cli.js check            # gateway + Hermes + provider config
node dist/cli.js provider-smoke   # real provider connect/close test
node dist/cli.js plugin install   # install the Hermes plugin
node dist/cli.js plugin status    # inspect the plugin installation
npm run verify                    # complete local release gate
```

Docker users can start from [examples/docker-compose.yml](examples/docker-compose.yml).

## Security And Maturity

Hermes Live Voice is a **developer preview for self-hosted, trusted-client use**. The architecture keeps long-lived credentials server-side and fails closed on unsafe network binds, but it is not a turnkey public multi-tenant service.

Before exposing it beyond localhost:

- terminate TLS in front of the gateway;
- require a high-entropy `HERMES_LIVE_AUTH_TOKEN`;
- restrict `HERMES_LIVE_ALLOW_ORIGIN` to the exact client origin;
- disable the bundled demo unless it is intentionally public;
- keep Hermes and provider endpoints private;
- add edge rate limits and cost controls;
- review [docs/security.md](docs/security.md) and [SECURITY.md](SECURITY.md).

Never paste secrets into an issue. Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Project Status

The core bridge is implemented and covered by type checks, unit tests, built-gateway smokes, fake Hermes HTTP/SSE integration, CLI tests, plugin checks, package installation tests, and a Docker build in CI.

What deterministic CI does **not** prove:

- valid external provider credentials or model entitlement;
- real microphone and speaker behavior;
- provider latency or cost under load;
- public multi-user safety;
- long-duration session reliability.

That distinction is intentional. See [docs/live-provider-testing.md](docs/live-provider-testing.md) and the [roadmap](docs/roadmap.md).

## Contributing

Focused contributions are welcome—especially client SDKs, safe structured progress narration, provider event fixtures, reconnect behavior, accessibility, and real-world deployment evidence.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Keep provider changes isolated, include tests, and avoid vendoring unrelated speech frameworks or rebranding the project inside a feature PR.

## License

[MIT](LICENSE). Hermes Agent, Gemini, and OpenAI are separate projects and services governed by their own licenses and terms.

---

<p align="center">
  <strong>Hermes already has the brain. Give it a realtime voice.</strong>
</p>
