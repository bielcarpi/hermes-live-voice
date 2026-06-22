# Local Setup

## 1. Start Hermes

Start Hermes API Server locally and confirm it exposes run endpoints.

```sh
curl -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/v1/capabilities
```

Set the same secret for the gateway:

```sh
HERMES_API_KEY=$API_SERVER_KEY
```

Current Hermes API Server deployments require `API_SERVER_KEY`, including local loopback deployments. The gateway uses `HERMES_API_KEY` as the bearer token when calling Hermes.

The gateway expects these feature flags to be true:

- `run_submission`
- `run_events_sse`
- `run_stop`
- `run_approval_response`

Hermes JSON requests time out after 30 seconds by default. Set `HERMES_LIVE_HERMES_TIMEOUT_MS` if your local or remote Hermes API Server needs a different bound.

Realtime provider sessions must report ready within 15 seconds by default. Set `HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS` if your provider or network needs a longer startup bound.

Text inputs and provider tool-call messages are limited to 20,000 characters by default. Set `HERMES_LIVE_MAX_TEXT_CHARS` if you need a different bound.

## 2. Install Gateway Dependencies

```sh
npm install
```

## 3. Choose a Provider

Mock:

```sh
HERMES_LIVE_PROVIDER=mock HERMES_API_KEY=$API_SERVER_KEY npm run dev
```

Gemini:

```sh
HERMES_LIVE_PROVIDER=gemini GEMINI_API_KEY=... HERMES_API_KEY=$API_SERVER_KEY npm run dev
```

The default Gemini Live model is `gemini-3.1-flash-live-preview`.

Gemini Enterprise / Vertex mode:

```sh
HERMES_LIVE_PROVIDER=gemini GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_PROJECT=... HERMES_API_KEY=$API_SERVER_KEY npm run dev
```

OpenAI:

```sh
HERMES_LIVE_PROVIDER=openai OPENAI_API_KEY=... HERMES_API_KEY=$API_SERVER_KEY npm run dev
```

`OPENAI_REALTIME_MODEL` defaults to `gpt-realtime-2`. Set it to `gpt-realtime-1.5` for current Realtime 1.x behavior.

## 4. Check Readiness

```sh
npm run check
curl http://127.0.0.1:8788/ready
```

If you bind the gateway to `0.0.0.0`, set `HERMES_LIVE_AUTH_TOKEN`; otherwise startup will fail unless you explicitly opt out with `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` for an isolated trusted network.

## 5. Open Demo

```txt
http://127.0.0.1:8788
```

The demo can send text through the gateway and, in supported browsers, capture microphone audio as PCM16 frames.

To run the gateway without serving the demo page:

```sh
HERMES_LIVE_DEMO_ENABLED=false npm run dev
```

Production runs default the demo off when `NODE_ENV=production`. If you want to test the demo through Docker or another production-like process, enable it explicitly:

```sh
HERMES_LIVE_DEMO_ENABLED=true docker compose -f examples/docker-compose.yml up
```

## 6. Terminal Smoke Test

With the gateway running:

```sh
node dist/cli.js client "What is the current status?"
```

Use `HERMES_LIVE_URL` if the gateway is running somewhere else.
