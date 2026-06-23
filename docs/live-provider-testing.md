# Live Provider Testing

Default CI uses fake Hermes clients and the mock realtime provider. That keeps pull requests deterministic, but it does not prove your Gemini Live or OpenAI Realtime credentials, model access, audio path, or Hermes API Server are working together.

Use this page before claiming a hosted gateway is ready.

## Prerequisites

- Hermes API Server running with run endpoints enabled.
- `HERMES_API_KEY` set to Hermes Agent's `API_SERVER_KEY`.
- A realtime provider key or authenticated Vertex/Gemini environment.
- `HERMES_LIVE_AUTH_TOKEN` set for any non-local gateway.
- `HERMES_LIVE_ALLOW_ORIGIN` set to your app origin for browser clients.
- TLS in front of the gateway for non-local clients.

## Step 1: Check Hermes And Provider Config

```sh
npm run check
```

Expected:

```json
{
  "ok": true
}
```

This proves only configuration and Hermes capabilities. It does not open a realtime provider session.

## Step 2: Start The Gateway

Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=... \
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_API_KEY=... \
HERMES_LIVE_AUTH_TOKEN=local-test-token \
npm run dev
```

Gemini Enterprise / Vertex:

```sh
HERMES_LIVE_PROVIDER=gemini \
GOOGLE_GENAI_USE_ENTERPRISE=true \
GOOGLE_CLOUD_PROJECT=... \
GOOGLE_CLOUD_LOCATION=us-central1 \
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_API_KEY=... \
HERMES_LIVE_AUTH_TOKEN=local-test-token \
npm run dev
```

OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai \
OPENAI_API_KEY=... \
OPENAI_REALTIME_MODEL=gpt-realtime-2 \
OPENAI_REALTIME_TURN_DETECTION=disabled \
HERMES_BASE_URL=http://127.0.0.1:8642 \
HERMES_API_KEY=... \
HERMES_LIVE_AUTH_TOKEN=local-test-token \
npm run dev
```

For current Realtime 1.x sessions:

```sh
OPENAI_REALTIME_MODEL=gpt-realtime-1.5
```

Use `gpt-realtime` only when intentionally testing the older Realtime model alias.

For OpenAI-managed turn detection:

```sh
OPENAI_REALTIME_TURN_DETECTION=semantic_vad
```

The included web demo defaults to a push-to-talk style mic toggle, so `disabled` is the simplest first smoke test.

## Step 3: Use The Web Demo

Open:

```txt
http://127.0.0.1:8788
```

Enter the token, connect, and send a text message first. Then test microphone input.

Expected evidence:

- `session.ready` appears.
- A text input starts a Hermes run.
- `run.started` appears.
- `run.event` messages stream from Hermes.
- `run.completed` appears.
- Assistant audio plays for live provider responses.
- Starting a new text/mic turn cancels queued provider speech.
- OpenAI interruptions include `conversation.item.truncate` when the client has audio item metadata and playback duration, including `0` ms for queued/unheard audio.
- With OpenAI VAD enabled, provider speech-start events reach the client as `input.speech_started`, and the client cancels provider output while stopping/truncating queued assistant playback.
- Approval requests render decision buttons.
- Stop sends `run.stop` and the gateway forwards Hermes cancellation.

## Step 4: Test Negative Cases

Auth:

```sh
curl -i http://127.0.0.1:8788/v1/capabilities
```

Expected when `HERMES_LIVE_AUTH_TOKEN` is set:

```txt
HTTP/1.1 401 Unauthorized
```

Readiness with auth:

```sh
curl -i -H "Authorization: Bearer local-test-token" http://127.0.0.1:8788/ready
```

Expected:

```txt
HTTP/1.1 200 OK
```

Health remains public:

```sh
curl -i http://127.0.0.1:8788/health
```

Expected:

```txt
HTTP/1.1 200 OK
```

## What This Still Does Not Prove

- Multi-tenant hosted auth.
- Billing or account management.
- Edge rate limiting.
- Mobile app UX.
- Long-duration session behavior beyond your manual test window.
- Provider-side quota, latency, and regional availability under production load.

## Provider Notes

OpenAI documents WebSockets as appropriate for server-to-server Realtime integrations and recommends WebRTC for browser/mobile clients that connect directly to OpenAI. `hermes-live` keeps provider credentials server-side, so its provider connection is a server-side WebSocket pipeline.

OpenAI Realtime model families currently include `gpt-realtime`, `gpt-realtime-1.5`, `gpt-realtime-mini`, and `gpt-realtime-2`. Use `gpt-realtime-2` when you want reasoning-capable voice behavior; use `gpt-realtime-1.5` when explicitly testing the current Realtime 1.x behavior.

OpenAI Realtime can run with VAD or push-to-talk. In this repo, `OPENAI_REALTIME_TURN_DETECTION=disabled` means the client sends `audio.end`; `semantic_vad` and `server_vad` delegate turn boundaries to OpenAI.

Clients can send `response.cancel` before a barge-in or new turn. The OpenAI adapter maps that to OpenAI Realtime's `response.cancel` event when a response is pending or active.

When OpenAI VAD reports speech start, the gateway emits `input.speech_started`. Browser and mobile clients should stop local assistant playback immediately and send `response.cancel`; include `truncate` when they have audio item metadata for queued or partially heard assistant audio.

Gemini Live expects raw PCM input and returns raw PCM output. The gateway normalizes PCM sample rates for the provider adapters, so clients should report the true capture sample rate in the audio MIME type.

The default `GEMINI_MODEL` is the Gemini API Live preview model used by this repo. Gemini Enterprise / Vertex deployments can expose a narrower supported-model list, so override `GEMINI_MODEL` to an Enterprise-supported Live model if `session.start` returns a provider model error.

References:

- OpenAI Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime WebSocket guide: https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI Realtime conversations: https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI GPT-Realtime-2 model: https://developers.openai.com/api/docs/models/gpt-realtime-2
- Gemini Live API: https://ai.google.dev/gemini-api/docs/live-api
- Gemini Enterprise Live API reference: https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/multimodal-live
