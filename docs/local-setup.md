# Local Setup From Source

This guide is for contributors running a checkout. For the published package, use the [README quick start](../README.md#quick-start).

## 1. Start Hermes Agent

Start Hermes API Server and inspect its authenticated capabilities:

```sh
curl -H "Authorization: Bearer $API_SERVER_KEY" \
  http://127.0.0.1:8642/v1/capabilities
```

Hermes Live requires:

- `run_submission`
- `run_status`
- `run_events_sse`
- `run_stop`
- `run_approval_response` (used only for fail-closed denial)

Expose the same key to the gateway:

```sh
export HERMES_AGENT_API_SERVER_KEY="$API_SERVER_KEY"
```

Current Hermes API Server deployments require `API_SERVER_KEY` even on loopback. `HERMES_API_KEY` remains a legacy alias.

## 2. Install And Build

```sh
npm ci
npm run build
```

Run deterministic checks before using live credentials:

```sh
npm run verify
npm audit --audit-level=moderate
```

## 3. Configure Durable Tasks

The defaults are suitable for one local user:

```sh
export HERMES_LIVE_TASK_STATE_FILE="$HOME/.hermes/hermes-live/tasks-v1.json"
export HERMES_LIVE_MAX_CONCURRENT_TASKS=3
export HERMES_LIVE_MAX_QUEUED_TASKS=32
export HERMES_LIVE_TASK_HISTORY_LIMIT=200
export HERMES_LIVE_TASK_RETENTION_HOURS=168
export HERMES_LIVE_TASK_POLL_INTERVAL_MS=2000
```

The state-file override must be an absolute path in a dedicated directory owned by the gateway process user. The gateway creates private `0700`/`0600` permissions and refuses corrupt or symlinked state rather than resetting it.

`exclusive` tasks run alone. Only tasks explicitly classified `parallel_read_only` can use multiple slots, and only when their resource keys are disjoint. See [Durable Background Tasks](background-tasks.md).

## 4. Choose A Realtime Provider

Mock is text-only and deterministic:

```sh
HERMES_LIVE_PROVIDER=mock npm run dev
```

Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini GEMINI_API_KEY=... npm run dev
```

The default model is `gemini-3.1-flash-live-preview`.

Gemini Enterprise / Vertex:

```sh
HERMES_LIVE_PROVIDER=gemini \
GOOGLE_GENAI_USE_ENTERPRISE=true \
GOOGLE_CLOUD_PROJECT=your-project \
GOOGLE_CLOUD_LOCATION=us-central1 \
npm run dev
```

The gateway validates the project, location, and optional `GOOGLE_GENAI_API_VERSION`, then pins the SDK to the corresponding official Google endpoint.

OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai OPENAI_API_KEY=... npm run dev
```

The defaults are `gpt-realtime-2.1`, voice `marin`, reasoning effort `low`, PCM16 input/output, and disabled VAD for push-to-talk. Override a model only after running the complete [live-provider test](live-provider-testing.md).

`HERMES_BASE_URL` accepts only a credential-free HTTP(S) root origin. `OPENAI_REALTIME_BASE_URL` accepts a credential-free WS(S) URL without a fragment; redirects are rejected and path/query text is redacted from diagnostics.

## 5. Check Readiness

In another terminal:

```sh
npm run check
curl http://127.0.0.1:8788/ready
curl http://127.0.0.1:8788/v1/capabilities
```

`/ready` reports gateway, task limits, Hermes, and provider configuration. `sessionChecked: false` is expected because readiness does not spend quota opening a provider session. `/v1/capabilities` should report `protocolVersion: 3`, durable background tasks, disconnect continuation, exact task stop, and the documented restart limits.

If `HERMES_LIVE_AUTH_TOKEN` is set, add `Authorization: Bearer ...` to the two authenticated HTTP requests.

Hermes JSON requests and initial SSE headers time out after `HERMES_LIVE_HERMES_TIMEOUT_MS` (default 30 seconds). An established event stream has an independent `HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS` watchdog (default 120 seconds) refreshed by events or keepalive bytes. Provider startup defaults to 15 seconds through `HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS`.

## 6. Use The Development Demo

Open:

```txt
http://127.0.0.1:8788
```

Connect, send text first, then test microphone permission and playback. The page should show an immediate task receipt, a durable inbox, lifecycle changes, separate speech/task stop controls, completion notifications, and retained results.

The demo defaults on in development and off when `NODE_ENV=production`. Disable it explicitly with:

```sh
HERMES_LIVE_DEMO_ENABLED=false npm run dev
```

## 7. Install The Dashboard Plugin

From the built checkout:

```sh
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
hermes dashboard
```

Choose **Live Voice**. The Dashboard tab uses Hermes authentication and a same-origin backend relay. For a remote gateway, configure these values only in the Dashboard server process:

```sh
HERMES_LIVE_URL=https://voice.example.com
HERMES_LIVE_AUTH_TOKEN=your-high-entropy-gateway-token
```

`HERMES_LIVE_URL` must be a credential-free HTTP(S) origin without a path, query, fragment, or embedded user information. The bearer stays server-side.

## 8. Use Terminal Clients

One-shot task/result smoke:

```sh
node dist/cli.js client "Inspect the repository and report its test status"
```

Persistent text-control session:

```sh
node dist/cli.js terminal
```

Useful commands:

```txt
/tasks
/status <taskId>
/result <taskId>
/ack <taskId>
/stop <taskId>
/interrupt
/quit
```

`/ack <taskId>` (or its `/read` alias) marks only that task's current unread notification as read. `/interrupt` stops provider speech; `/stop <taskId>` requests cancellation of one exact task; `/quit`, Ctrl+C, and connection loss only detach. The terminal has no microphone/audio dependency but still opens a realtime-provider session and can incur provider usage.

Set `HERMES_LIVE_URL` to an HTTP(S) gateway origin or WS(S) endpoint for a remote CLI. Set `HERMES_LIVE_AUTH_TOKEN` separately; never embed credentials in the URL.

## 9. Run With Docker

The Compose example requires both Hermes and gateway credentials:

```sh
HERMES_AGENT_API_SERVER_KEY=your-hermes-api-server-key \
HERMES_LIVE_AUTH_TOKEN=$(openssl rand -hex 32) \
HERMES_LIVE_PROVIDER=mock \
docker compose -f examples/docker-compose.yml up --build
```

For repeat use, put secrets in a protected env file and pass `--env-file` instead of leaving them in shell history.

The example:

- publishes only to `127.0.0.1` by default;
- uses a read-only root filesystem, bounded `/tmp`, dropped capabilities, and `no-new-privileges`;
- runs as the image's non-root `node` user;
- persists `/var/lib/hermes-live/tasks-v1.json` in the `hermes-live-state` volume.

Do not remove that volume if you expect gateway-restart recovery or retained task history. Set `HERMES_LIVE_HOST_PORT` for a different loopback port and put a TLS reverse proxy in front for remote access.

## Recovery Smoke

Before relying on background work:

1. Start a long task and disconnect the client; reconnect and confirm the snapshot restores it.
2. Restart only Hermes Live while Hermes stays alive; confirm the persisted task reconciles.
3. In a disposable environment, restart Hermes and confirm the old task becomes `unknown` rather than falsely completed or failed.
4. Stop one exact task while another runs and confirm only the selected id changes.
5. Exercise an approval-requiring task and confirm deny-all plus stop, with no approval buttons or commands.

For ambiguous dispatch and state-file recovery, follow the [operator procedure](background-tasks.md#ambiguous-dispatch-fence) instead of editing JSON.
