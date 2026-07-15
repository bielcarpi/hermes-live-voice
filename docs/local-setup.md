# Local Setup From Source

This guide is for contributors running a repository checkout. For the packaged installation, start with the npm-first [Quick Start](../README.md#quick-start).

## 1. Start Hermes

Start Hermes API Server locally and confirm it exposes run endpoints.

```sh
curl -H "Authorization: Bearer $API_SERVER_KEY" http://127.0.0.1:8642/v1/capabilities
```

Set the same secret for the gateway:

```sh
HERMES_AGENT_API_SERVER_KEY=$API_SERVER_KEY
```

Current Hermes API Server deployments require `API_SERVER_KEY`, including local loopback deployments. The gateway uses `HERMES_AGENT_API_SERVER_KEY` as the bearer token when calling Hermes. `HERMES_API_KEY` remains supported as a legacy alias.

The gateway expects these feature flags to be true:

- `run_submission`
- `run_events_sse`
- `run_stop`
- `run_approval_response`

Hermes JSON requests and initial run-event response headers time out after 30 seconds by default. Set `HERMES_LIVE_HERMES_TIMEOUT_MS` to a positive number of milliseconds if your local or remote Hermes API Server needs a different bound. After Hermes opens a run-event SSE response, a separate idle watchdog defaults to 120 seconds (`HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS`). Any received SSE bytes reset that watchdog, including Hermes' normal keepalive comments, so a healthy long-running task can continue while a silent dead stream fails visibly. Both values must be positive; zero/unbounded requests or streams are rejected.

Realtime provider sessions must report ready within 15 seconds by default. Set `HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS` if your provider or network needs a longer startup bound.

Provider shutdown is also confirmation-based: the gateway waits for the upstream provider's close event and reports cleanup as unconfirmed if it never arrives. The Google Gen AI SDK does not currently expose its pre-open WebSocket, so a timed-out Gemini handshake cannot be physically aborted in place. The gateway retains that pending attempt, reports cleanup as unconfirmed if it misses the cleanup deadline, and closes the session if the SDK later returns one; the provider-smoke command applies the same late-close safeguard after reporting a timeout.

The one-shot `hermes-live client` command must complete both its WebSocket upgrade and protocol `session.ready` handshake within 10 seconds by default. Set `HERMES_LIVE_CLIENT_READY_TIMEOUT_MS` only when a slower trusted network requires it.

Text inputs and provider tool-call messages are limited to 20,000 characters by default. Set `HERMES_LIVE_MAX_TEXT_CHARS` if you need a different bound.

The gateway uses server-owned Hermes identity by default: `HERMES_LIVE_PROFILE_ID=default` and `HERMES_LIVE_USER_LABEL=voice`. Client-supplied `profileId` and `userLabel` values are ignored unless `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true`. Only enable that option when every client is trusted to select its own Hermes memory scope.

`HERMES_LIVE_RUN_EVENT_DETAIL=summary` forwards only allowlisted run metadata. Use `none` for the smallest client surface or `raw` only for a trusted developer client that is allowed to see Hermes event payloads.

The gateway accepts up to eight concurrent WebSocket sessions by default. Set `HERMES_LIVE_MAX_SESSIONS` to a positive value that matches your provider quota and cost controls.

## 2. Install Gateway Dependencies

```sh
npm ci
```

## 3. Choose a Provider

Mock:

```sh
HERMES_LIVE_PROVIDER=mock HERMES_AGENT_API_SERVER_KEY=$API_SERVER_KEY npm run dev
```

Gemini:

```sh
HERMES_LIVE_PROVIDER=gemini GEMINI_API_KEY=... HERMES_AGENT_API_SERVER_KEY=$API_SERVER_KEY npm run dev
```

The default Gemini Live model is `gemini-3.1-flash-live-preview`.

Gemini Enterprise / Vertex mode:

```sh
HERMES_LIVE_PROVIDER=gemini GOOGLE_GENAI_USE_ENTERPRISE=true GOOGLE_CLOUD_PROJECT=... HERMES_AGENT_API_SERVER_KEY=$API_SERVER_KEY npm run dev
```

Vertex mode accepts a canonical Google Cloud project id and location such as `us-central1`, plus an optional bounded `GOOGLE_GENAI_API_VERSION` token such as `v1beta`. The gateway derives and pins the corresponding official Google endpoint; ambient `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`, or SDK cloud-mode variables cannot retarget the connection.

OpenAI:

```sh
HERMES_LIVE_PROVIDER=openai OPENAI_API_KEY=... HERMES_AGENT_API_SERVER_KEY=$API_SERVER_KEY npm run dev
```

`OPENAI_REALTIME_MODEL` defaults to the currently documented `gpt-realtime-2.1`. `OPENAI_REALTIME_REASONING_EFFORT` applies to Realtime 2 models and accepts `minimal`, `low`, `medium`, `high`, or `xhigh`. Override the model only after validating it against the live-provider checklist.

`HERMES_BASE_URL` accepts only a credential-free HTTP(S) root origin. `OPENAI_REALTIME_BASE_URL` accepts a credential-free WS(S) URL without a fragment; a documented custom path and query are preserved for the connection, but WebSocket redirects are rejected. Path text, query names, and query values are redacted from readiness and `print-config`, so do not depend on those diagnostics to recover provider URL parameters.

## 4. Check Readiness

```sh
npm run check
curl http://127.0.0.1:8788/ready
```

Both commands report gateway, Hermes, and realtime provider readiness. A `503` response includes an `error` on the failing section. Realtime readiness includes `sessionChecked: false` because these checks do not open a live Gemini/OpenAI session.

If you bind the gateway to `0.0.0.0`, set a strong `HERMES_LIVE_AUTH_TOKEN`; otherwise startup will fail unless you explicitly opt out with `HERMES_LIVE_ALLOW_UNAUTHENTICATED=true` for an isolated trusted network.

## 5. Open Hermes Dashboard

Install and enable the plugin, start the companion gateway, then start or restart Hermes Dashboard:

```sh
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
hermes dashboard
```

Choose **Live Voice**. The tab reports gateway/provider capabilities before connection and uses Hermes Dashboard authentication for its same-origin HTTP and WebSocket proxy.

When the gateway is remote, set `HERMES_LIVE_URL` in the Dashboard process to a credential-free HTTP(S) origin such as `https://voice.example.com`. Dashboard configuration rejects WS(S) URLs, paths, user information, query parameters, and fragments. Set `HERMES_LIVE_AUTH_TOKEN` separately in the Dashboard server environment; it is never returned to browser code.

## 6. Open The Development Demo

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
HERMES_AGENT_API_SERVER_KEY=$API_SERVER_KEY \
HERMES_LIVE_AUTH_TOKEN=your-random-gateway-token \
HERMES_LIVE_DEMO_ENABLED=true \
docker compose -f examples/docker-compose.yml up --build
```

The Compose example requires both gateway/Hermes credentials and publishes only on `127.0.0.1` by default. For repeat use, put values in a protected env file and pass `--env-file`. Set `HERMES_LIVE_HOST_PORT` to choose a different host port; use a TLS reverse proxy for remote access rather than removing the loopback bind without equivalent network controls. Its container filesystem is read-only except for a bounded `/tmp` tmpfs.

## 7. Terminal Clients

With the gateway running:

```sh
node dist/cli.js client "What is the current status?"
```

That one-shot client is useful in smoke tests. For a persistent interactive session:

```sh
node dist/cli.js terminal
```

The terminal console supports text turns, sanitized task state, negotiated approval requests or compatibility warnings, `/interrupt`, and `/stop`. It does not capture or play gateway audio, but it still opens a realtime-provider session and can incur provider usage. Use it for interactive remote control or diagnostics, not deterministic automation. For first-party local microphone use, use Hermes Voice Mode or Desktop; for remote gateway voice, use the Dashboard or browser UI.

For the CLI clients, `HERMES_LIVE_URL` may be an HTTP(S) gateway origin or a WS(S) endpoint. The CLI normalizes an origin to `/v1/live` and sends `HERMES_LIVE_AUTH_TOKEN` as an upgrade header. Do not embed credentials in the URL.

This CLI URL flexibility does not apply to the Dashboard backend. Its `HERMES_LIVE_URL` must be the credential-free HTTP(S) origin described in step 5.
