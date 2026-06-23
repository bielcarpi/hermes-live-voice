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

The default Gemini Live model is `gemini-live-2.5-flash-native-audio`.

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
