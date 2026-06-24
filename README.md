# hermes-live

Hermes Agent plugin and realtime voice gateway.

`hermes-live` adds realtime voice to Hermes Agent. The Hermes plugin provides the discovery/integration surface, and the gateway runtime handles realtime WebSockets, audio frames, provider sessions, and app-client auth. Hermes remains the brain: memory, tools, skills, terminal, files, MCP, approvals, and long-running work stay inside Hermes.

```txt
Client app
  -> WebSocket /v1/live
  -> hermes-live plugin/gateway
  -> Gemini Live or OpenAI Realtime
  -> function call: start_hermes_run()
  -> Hermes API Server /v1/runs
  -> Hermes tools, memory, skills, MCP
```

## Why this exists

Hermes already has the hard agent parts. Realtime voice has a different runtime shape: persistent WebSockets, audio frames, fast turn-taking, barge-in, provider sessions, app-client auth, and gateway-level safety. Keeping that runtime as a plugin-managed gateway means people can use realtime voice without forking Hermes or waiting for a native Hermes platform adapter.

The repo is intentionally Hermes-centered. It does not depend on any particular app, product, or hosted service.

## Status

This repository is an early Hermes plugin package with a realtime gateway runtime. It is designed for self-hosted Hermes installations and integration work.

Implemented:

- `GET /health`
- `GET /ready`
- `GET /v1/capabilities`
- `WS /v1/live`
- Gemini Live adapter
- OpenAI Realtime adapter
- Mock provider for local development
- Hermes `/v1/runs` client
- Hermes run event streaming over SSE
- Run stop/interruption bridge
- Approval response bridge
- Static browser demo
- Hermes plugin registration, discovery helper, status tool, and slash command

## Install

From a clone:

```sh
npm install
npm run build
```

After the package is published, users can install the CLI globally:

```sh
npm install -g hermes-live
```

Or run the Docker example:

```sh
HERMES_API_KEY=... HERMES_LIVE_AUTH_TOKEN=$(openssl rand -hex 32) \
docker compose -f examples/docker-compose.yml up
```

## Configure

Copy `.env.example` and set the pieces you need.

```sh
cp .env.example .env
```

For Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini
GEMINI_API_KEY=...
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=...
```

Set `HERMES_API_KEY` to the same value as Hermes Agent's `API_SERVER_KEY`. Current Hermes API Server deployments require bearer auth, and Hermes only accepts the long-term memory `X-Hermes-Session-Key` header from authenticated clients. `hermes-live` keeps that session key server-side and sends it to Hermes on run creation and follow-up run-scoped calls.

Hermes JSON requests time out after 30 seconds by default. To tune that for a slower local or remote Hermes API Server:

```sh
HERMES_LIVE_HERMES_TIMEOUT_MS=60000
```

Realtime provider sessions must become ready within 15 seconds by default. To tune that for slower provider handshakes:

```sh
HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS=30000
```

Text inputs and provider tool-call messages are limited to 20,000 characters by default:

```sh
HERMES_LIVE_MAX_TEXT_CHARS=20000
```

For Vertex/Gemini Enterprise mode, also set:

```sh
GOOGLE_GENAI_USE_ENTERPRISE=true
GOOGLE_CLOUD_PROJECT=...
GOOGLE_CLOUD_LOCATION=us-central1
```

For OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_TURN_DETECTION=disabled
HERMES_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=...
```

For current OpenAI Realtime 1.x behavior, set:

```sh
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
```

The older `gpt-realtime` alias is still accepted if your OpenAI account is pinned to that model family.

`OPENAI_REALTIME_TURN_DETECTION=disabled` keeps push-to-talk behavior where clients send `audio.end`. Set it to `semantic_vad` or `server_vad` for OpenAI-managed turn detection.

For local gateway development without a realtime provider:

```sh
HERMES_LIVE_PROVIDER=mock
HERMES_API_KEY=...
```

The mock provider still requires a Hermes API Server with run endpoints unless tests inject a fake Hermes client.

When binding beyond loopback, protect the gateway:

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

The built-in browser demo is enabled by default for local development and disabled by default when `NODE_ENV=production`. To force it off:

```sh
HERMES_LIVE_DEMO_ENABLED=false
```

To expose it intentionally in a production/container environment:

```sh
HERMES_LIVE_DEMO_ENABLED=true
```

Useful commands:

```sh
npm run dev
node dist/cli.js client "What can Hermes do?"
npm run check              # gateway, Hermes API, and provider readiness
npm run check:cli-client
npm run check:gateway
npm run check:web-demo
npm run print-config
npm run verify
```

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

## Terminal Client

After starting the gateway, send one text prompt through it:

```sh
node dist/cli.js client "Summarize my current project state."
```

When installed globally:

```sh
hermes-live client "Summarize my current project state."
```

Set `HERMES_LIVE_URL` when the gateway is not on `ws://127.0.0.1:8788/v1/live`. If `HERMES_LIVE_AUTH_TOKEN` is set, the client sends it as a bearer token.

The terminal client prints Hermes run output when the provider calls Hermes. If the realtime provider answers directly, it prints the provider transcript when that realtime response completes. If the provider completes with audio but no text transcript, the terminal client exits with a clear error; use the web demo or another voice client for audio-only responses.

## Hermes Plugin And Gateway

`hermes-live` should be treated as a Hermes plugin package.

The plugin gives Hermes a stable discovery/integration surface, registers a `hermes_live_status` tool, and adds a `/hermes-live` slash command for local gateway status. The gateway runtime is the network/audio process that the plugin points to. Keeping the WebSocket and provider sessions in that runtime avoids pushing long-lived audio sockets into Hermes core while still making the project installable and understandable as a Hermes extension.

See [docs/plugin.md](docs/plugin.md).

## Security Model

Do not expose Hermes directly to untrusted mobile or browser clients. Expose `hermes-live`, require gateway auth, restrict origins, and keep provider and Hermes credentials server-side.

See [docs/security.md](docs/security.md).

## Development

```sh
npm install
npm run verify
```

The test suite uses mock providers and fake Hermes clients. Live provider tests require external credentials and are intentionally not part of the default CI gate.

`npm run check:gateway` builds confidence in the packaged path by starting `dist/cli.js serve`, opening `/v1/live`, and driving a fake Hermes run over HTTP/SSE.

Use [docs/live-provider-testing.md](docs/live-provider-testing.md) before claiming a real Gemini Live or OpenAI Realtime deployment is ready.

## References

- OpenAI Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime API reference: https://developers.openai.com/api/reference/resources/realtime
- OpenAI GPT-Realtime-2 model: https://developers.openai.com/api/docs/models/gpt-realtime-2
- Gemini Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Gemini Live API reference: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-live
- Google Gen AI JavaScript SDK: https://github.com/googleapis/js-genai
- Hermes Agent: https://github.com/NousResearch/hermes-agent
