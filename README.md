# hermes-live

Realtime voice gateway for Hermes Agent.

`hermes-live` lets browser, mobile, or desktop clients speak to a private Hermes Agent through a realtime speech model. The realtime provider handles low-latency audio and interruption. Hermes remains the brain: memory, tools, skills, terminal, files, MCP, approvals, and long-running work stay inside Hermes.

```txt
Client app
  -> WebSocket /v1/live
  -> hermes-live
  -> Gemini Live or OpenAI Realtime
  -> function call: start_hermes_run()
  -> Hermes API Server /v1/runs
  -> Hermes tools, memory, skills, MCP
```

## Why this exists

Hermes already has the hard agent parts. Realtime voice has a different runtime shape: persistent WebSockets, audio frames, fast turn-taking, barge-in, provider sessions, mobile auth, and gateway-level safety. Keeping this as a sidecar means people can use it without forking Hermes or waiting for a native Hermes platform adapter.

## Status

This repository is an early gateway. It is designed for self-hosted experimentation and integration work, not hosted multi-tenant production without additional hardening.

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
- Optional Hermes plugin metadata/stub

Not implemented in this repo:

- Hosted user accounts
- Billing
- Mobile app UX
- Persistent gateway database
- Public tunnel management
- Production observability stack

## Install

```sh
npm install
npm run build
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
```

For OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_REALTIME_MODEL=gpt-realtime-2
HERMES_BASE_URL=http://127.0.0.1:8642
```

For OpenAI Realtime 1 style models, set:

```sh
OPENAI_REALTIME_MODEL=gpt-realtime
```

For local gateway development without a realtime provider:

```sh
HERMES_LIVE_PROVIDER=mock
```

The mock provider still requires a Hermes API Server with run endpoints unless tests inject a fake Hermes client.

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
npm run check
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

## Plugin or Sidecar?

`hermes-live` is primarily a sidecar gateway.

That is intentional. Realtime voice needs long-lived WebSockets, provider sessions, browser/mobile auth, and audio IO. A Hermes plugin is useful for discovery and local convenience, but it should not be the only way to use the project. See [docs/plugin.md](docs/plugin.md).

## Security Model

Do not expose Hermes directly to untrusted mobile or browser clients. Expose `hermes-live`, require gateway auth, restrict origins, and keep provider and Hermes credentials server-side.

See [docs/security.md](docs/security.md).

## Development

```sh
npm install
npm run verify
```

The test suite uses mock providers and fake Hermes clients. Live provider tests require external credentials and are intentionally not part of the default CI gate.

## References

- OpenAI Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime API reference: https://developers.openai.com/api/reference/resources/realtime
- Gemini Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Gemini 2.5 Flash Live model: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api
- Google Gen AI JavaScript SDK: https://github.com/googleapis/js-genai
- Hermes Agent: https://github.com/NousResearch/hermes-agent
