# Local Setup

## 1. Start Hermes

Start Hermes API Server locally and confirm it exposes run endpoints.

```sh
curl http://127.0.0.1:8642/v1/capabilities
```

The gateway expects these feature flags to be true:

- `run_submission`
- `run_events_sse`
- `run_stop`
- `run_approval_response`

## 2. Install Gateway Dependencies

```sh
npm install
```

## 3. Choose a Provider

Mock:

```sh
HERMES_LIVE_PROVIDER=mock npm run dev
```

Gemini:

```sh
HERMES_LIVE_PROVIDER=gemini GEMINI_API_KEY=... npm run dev
```

The default Gemini Live model is `gemini-3.1-flash-live-preview`.

Gemini Enterprise / Vertex mode:

```sh
HERMES_LIVE_PROVIDER=gemini GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_PROJECT=... npm run dev
```

OpenAI:

```sh
HERMES_LIVE_PROVIDER=openai OPENAI_API_KEY=... npm run dev
```

## 4. Check Readiness

```sh
npm run check
curl http://127.0.0.1:8788/ready
```

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
