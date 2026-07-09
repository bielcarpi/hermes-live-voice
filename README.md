<p align="center">
  <img src="assets/banner.svg" alt="Hermes Live Voice" width="100%">
</p>

<h1 align="center">Hermes Live Voice</h1>

<p align="center">
  <strong>Realtime speech models for Hermes Agent.</strong>
</p>

<p align="center">
  <a href="https://github.com/NousResearch/hermes-agent">Hermes Agent</a>
  |
  <a href="docs/architecture.md">Architecture</a>
  |
  <a href="docs/plugin.md">Plugin</a>
  |
  <a href="docs/client-protocol.md">Client Protocol</a>
  |
  <a href="docs/live-provider-testing.md">Live Provider Testing</a>
</p>

<p align="center">
  <img alt="Status: v0.1.0" src="https://img.shields.io/badge/status-v0.1.0-ffcc00?style=for-the-badge">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-16a34a?style=for-the-badge">
  <img alt="Providers: Gemini Live and OpenAI Realtime" src="https://img.shields.io/badge/providers-Gemini%20Live%20%2B%20OpenAI%20Realtime-7c3aed?style=for-the-badge">
  <img alt="Runtime: Node 20+" src="https://img.shields.io/badge/runtime-Node%2020%2B-334155?style=for-the-badge">
</p>

`hermes-live-voice` is an open-source Hermes Agent plugin and realtime voice gateway. It lets browsers, mobile apps, desktop clients, or terminal smoke tests talk to Hermes through realtime speech APIs.

Gemini Live and OpenAI Realtime handle the voice loop: speech input, speech output, turn-taking, interruption, and low-latency conversational flow. Hermes remains the brain: memory, tools, skills, terminal/file access, MCP, approvals, and long-running runs stay inside Hermes.

```txt
Client app
  -> WebSocket /v1/live
  -> hermes-live gateway
  -> Gemini Live or OpenAI Realtime
  -> gateway tool call: start_hermes_run()
  -> Hermes API Server /v1/runs
  -> Hermes tools, memory, skills, MCP
```

This repo is Hermes-centered only. It is not tied to any hosted product, app, billing system, or private assistant UX.

## How Hermes Talks To You

The gateway gives the realtime model one job: be the live voice interface. It does not hand Gemini or OpenAI your full Hermes toolbelt.

1. Your client streams microphone audio or text to `WS /v1/live`.
2. `hermes-live` opens a Gemini Live or OpenAI Realtime session from the server.
3. The realtime model listens and speaks naturally.
4. When the user asks for real work, the model calls `start_hermes_run`.
5. The gateway starts a Hermes `/v1/runs` task, streams progress back, forwards approvals, and stops the run if the user interrupts.
6. The realtime model turns the Hermes result into a short spoken response.

That split is the product:

```txt
Realtime model = ears, mouth, turn-taking
Hermes         = brain, memory, tools, actions
hermes-live    = secure translator between them
```

## Why It Exists

Hermes already has the hard agent layer. Realtime voice has a different runtime shape: persistent WebSockets, audio frames, provider sessions, fast barge-in, client auth, and gateway-level safety. Keeping that runtime in a plugin-managed gateway lets people add voice to Hermes without forking Hermes core.

| What you get | How it works |
| --- | --- |
| Hermes plugin | Installs as `hermes-live`, registers `hermes_live_status`, and exposes a `/hermes-live` slash command. |
| Realtime gateway | Owns `/v1/live`, provider sessions, audio frames, auth, origin checks, and static demo serving. |
| Provider bridge | Supports Gemini Live, OpenAI Realtime, a local speech-to-speech backend, and a mock provider for local development. |
| Hermes run bridge | Starts Hermes runs, streams events, forwards approvals, and stops active runs on interruption/disconnect. |
| Client protocol | JSON over WebSocket with PCM16 audio frames, text smoke messages, run events, provider transcripts, and errors. |

## Status

`v0.1.0` is the first GitHub release line. It is intended for self-hosted Hermes installations and integration work.

Implemented:

- `GET /health`
- `GET /ready`
- `GET /v1/capabilities`
- `WS /v1/live`
- Gemini Live adapter
- OpenAI Realtime adapter
- Local speech-to-speech adapter (hf-realtime-voice backend)
- Mock provider for local development
- Hermes `/v1/runs` client
- Hermes run event streaming over SSE
- Run stop/interruption bridge
- Approval response bridge
- Static browser demo
- Hermes plugin registration, discovery helper, status tool, and slash command

## Install From GitHub

This project is not published to npm yet. Use the GitHub release/tag.

```sh
git clone https://github.com/bielcarpi/hermes-live-voice.git
cd hermes-live-voice
git checkout v0.1.0
npm install
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
```

Start the gateway:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_AGENT_API_SERVER_KEY=... \
HERMES_LIVE_PROVIDER=mock \
npm run dev
```

Then open the browser demo:

```txt
http://127.0.0.1:8788
```

`HERMES_LIVE_PROVIDER=mock` is the zero-credential path for checking that the gateway, browser demo, terminal client, and Hermes run bridge are wired correctly. To hear real realtime speech, switch `HERMES_LIVE_PROVIDER` to `gemini` or `openai` and add the matching provider key below.

Or run the Docker example from a clone:

```sh
HERMES_AGENT_API_SERVER_KEY=... HERMES_LIVE_AUTH_TOKEN=$(openssl rand -hex 32) \
docker compose -f examples/docker-compose.yml up
```

## Configure

Copy `.env.example` and set the pieces you need.

```sh
cp .env.example .env
```

Hermes API Server:

```sh
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_AGENT_API_SERVER_KEY=...
```

Set `HERMES_AGENT_API_SERVER_KEY` to the same value as Hermes Agent's `API_SERVER_KEY`. Current Hermes API Server deployments require bearer auth, and Hermes only accepts the long-term memory `X-Hermes-Session-Key` header from authenticated clients. `hermes-live` keeps that session key server-side and sends it to Hermes on run creation and follow-up run-scoped calls.

`HERMES_API_KEY` remains supported as a legacy alias, but new installs should use `HERMES_AGENT_API_SERVER_KEY`.

Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.1-flash-live-preview
```

OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_TURN_DETECTION=disabled
```

Local speech-to-speech (hf-realtime-voice backend):

```sh
HERMES_LIVE_PROVIDER=local
HERMES_LOCAL_REALTIME_BASE_URL=ws://127.0.0.1:8765/v1/realtime
HERMES_LOCAL_REALTIME_VOICE=Aiden
```

Requires a separately-running `hf-realtime-voice` speech-to-speech backend (its own Python process, started independently). See [docs/live-provider-testing.md](docs/live-provider-testing.md) for setup and the single-session limitation.

For current OpenAI Realtime 1.x behavior:

```sh
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
```

Realtime 2 reasoning effort defaults to `low`. You can set `OPENAI_REALTIME_REASONING_EFFORT` to `minimal`, `low`, `medium`, `high`, or `xhigh`.

After setting real provider credentials, run an optional live session handshake:

```sh
npm run check:live-provider
```

This wraps the CLI command:

```sh
node dist/cli.js provider-smoke
```

Both commands open and close a Gemini Live or OpenAI Realtime session with the same adapter the gateway uses. They do not require Hermes to be running, send user audio/text, or start a Hermes run.

Local mock provider:

```sh
HERMES_LIVE_PROVIDER=mock
HERMES_AGENT_API_SERVER_KEY=...
```

Network-exposed gateway:

```sh
HERMES_LIVE_HOST=0.0.0.0
HERMES_LIVE_AUTH_TOKEN=$(openssl rand -hex 32)
HERMES_LIVE_ALLOW_ORIGIN=https://your-app.example
```

`hermes-live` refuses network-accessible binds without a strong `HERMES_LIVE_AUTH_TOKEN` unless you explicitly set `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` for an isolated trusted network.

## Run

```sh
npm run dev
```

Then open:

```txt
http://127.0.0.1:8788
```

Useful commands:

```sh
npm run dev
node dist/cli.js client "What can Hermes do?"
node dist/cli.js provider-smoke
node dist/cli.js plugin install
node dist/cli.js plugin status
npm run check              # gateway, Hermes API, and provider readiness
npm run verify
```

The built-in browser demo is enabled by default for local development and disabled by default when `NODE_ENV=production`.

## Client Protocol

Connect to:

```txt
ws://127.0.0.1:8788/v1/live
```

If `HERMES_LIVE_AUTH_TOKEN` is set, `/v1/live`, `/ready`, and `/v1/capabilities` require either:

```txt
Authorization: Bearer <token>
```

or, for browser WebSocket clients that cannot set upgrade headers:

```txt
/v1/live?token=<token>
```

First message:

```json
{
  "type": "session.start",
  "profileId": "default",
  "userLabel": "alice"
}
```

Then send audio:

```json
{
  "type": "audio.input",
  "data": "<base64 pcm16>",
  "mimeType": "audio/pcm;rate=24000"
}
```

Or send text for smoke testing:

```json
{
  "type": "text.input",
  "text": "Summarize my current project state."
}
```

See [docs/client-protocol.md](docs/client-protocol.md).

## Architecture

The TypeScript gateway uses a small ports-and-adapters layout:

```txt
domain/                  wire protocol and audio primitives
application/live-gateway gateway session orchestration and ports
adapters/inbound/http    HTTP, WebSocket, and static demo transport
adapters/outbound/hermes Hermes API Server HTTP/SSE client
adapters/outbound/realtime Gemini, OpenAI, and mock realtime providers
```

`LiveGatewaySession` depends on application ports, not raw WebSocket, provider SDK, or Hermes HTTP details.

See [docs/architecture.md](docs/architecture.md).

## Hermes Plugin

The GitHub repo/package name is `hermes-live-voice`. The installed CLI command and Hermes plugin id are intentionally `hermes-live`.

The plugin gives Hermes a stable discovery/integration surface, registers a `hermes_live_status` tool, and adds a `/hermes-live` slash command for local gateway status. Install it with `node dist/cli.js plugin install`, then enable it with `hermes plugins enable hermes-live`.

See [docs/plugin.md](docs/plugin.md).

## Security

Do not expose Hermes directly to untrusted mobile or browser clients. Expose `hermes-live`, require gateway auth, restrict origins, and keep provider and Hermes credentials server-side.

See [docs/security.md](docs/security.md).

## Development

```sh
npm install
npm run verify
```

The test suite uses mock providers and fake Hermes clients. Live provider tests require external credentials and are intentionally not part of the default CI gate.

`npm run check:gateway` builds confidence in the packaged path by starting `dist/cli.js serve`, opening `/v1/live`, and driving a fake Hermes run over HTTP/SSE.

`npm run check:live-provider` and `node dist/cli.js provider-smoke` are optional and only run when you set `HERMES_LIVE_PROVIDER=gemini` or `HERMES_LIVE_PROVIDER=openai` with valid provider credentials.

Use [docs/live-provider-testing.md](docs/live-provider-testing.md) before claiming a real Gemini Live or OpenAI Realtime deployment is ready.

## References

- OpenAI Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime API reference: https://developers.openai.com/api/reference/resources/realtime
- OpenAI GPT-Realtime-2 model: https://developers.openai.com/api/docs/models/gpt-realtime-2
- Gemini Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Gemini Live API reference: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-live
- Google Gen AI JavaScript SDK: https://github.com/googleapis/js-genai
- Hermes Agent: https://github.com/NousResearch/hermes-agent
