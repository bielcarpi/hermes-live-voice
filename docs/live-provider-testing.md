# Live Provider Testing

CI uses fake Hermes clients and the mock realtime provider. That proves deterministic contracts, not your credentials, provider model access, microphone/playback path, notification behavior, or the complete Hermes integration.

Use this checklist before describing a deployment—or a release whose provider adapter changed—as ready.

Commands assume the installed package. From source, use `npm run check`, `npm run check:live-provider`, and `npm run dev` instead of `hermes-live check`, `hermes-live provider-smoke`, and `hermes-live serve`.

## Prerequisites

- Hermes API Server running with its Runs API enabled;
- `HERMES_AGENT_API_SERVER_KEY` set to Hermes `API_SERVER_KEY`;
- a Gemini/OpenAI key or authenticated Vertex environment;
- a persistent private `HERMES_LIVE_TASK_STATE_FILE`;
- `HERMES_LIVE_AUTH_TOKEN` for non-loopback binds;
- exact browser origin and TLS for non-local clients.

## 1. Check Configuration And Hermes

```sh
hermes-live check
```

Expected shape:

```json
{
  "ok": true,
  "gateway": {
    "ok": true,
    "host": "127.0.0.1",
    "port": 8788,
    "authRequired": false,
    "tasks": {
      "durable": true,
      "maxConcurrent": 3,
      "maxQueued": 32,
      "maxRetained": 200
    }
  },
  "hermes": {
    "ok": true,
    "baseUrl": "http://127.0.0.1:8642",
    "model": "hermes-agent"
  },
  "realtime": {
    "ok": true,
    "configured": true,
    "provider": "openai",
    "model": "gpt-realtime-2.1",
    "sessionChecked": false
  }
}
```

Exact Hermes fields vary by version. Verify `run_submission`, `run_status`, `run_events_sse`, `run_stop`, and `run_approval_response` are true. `sessionChecked: false` is intentional: this check does not open a billable provider session.

Also inspect the authenticated capabilities endpoint:

```sh
curl -H "Authorization: Bearer $HERMES_LIVE_AUTH_TOKEN" \
  http://127.0.0.1:8788/v1/capabilities
```

Confirm `protocolVersion: 3`, `background_tasks`, durable local persistence, exact stop, reconnect snapshots, notification support, configured task bounds, gateway-restart reconciliation, `hermesRestartRecovery: false`, and fenced ambiguous dispatch.

## 2. Open And Close A Real Provider Session

```sh
hermes-live provider-smoke
```

Expected:

```json
{
  "ok": true,
  "provider": "openai",
  "model": "gpt-realtime-2.1",
  "connected": true
}
```

This uses the same adapter as the gateway, waits for provider readiness, then confirms provider closure. It does not require Hermes, send audio/text, or start a task. Set `HERMES_LIVE_PROVIDER_SMOKE_TIMEOUT_MS` only when a trusted slower network needs a larger bound.

Provider-controlled error text and close reasons are intentionally suppressed. Use the provider's authenticated console for deeper diagnostics rather than weakening redaction.

## 3. Start The Integrated Gateway

Gemini Live:

```sh
HERMES_LIVE_PROVIDER=gemini \
GEMINI_API_KEY=... \
HERMES_AGENT_API_SERVER_KEY=... \
HERMES_LIVE_AUTH_TOKEN=local-test-token \
hermes-live serve
```

Gemini Enterprise / Vertex:

```sh
HERMES_LIVE_PROVIDER=gemini \
GOOGLE_GENAI_USE_ENTERPRISE=true \
GOOGLE_CLOUD_PROJECT=... \
GOOGLE_CLOUD_LOCATION=us-central1 \
HERMES_AGENT_API_SERVER_KEY=... \
HERMES_LIVE_AUTH_TOKEN=local-test-token \
hermes-live serve
```

OpenAI Realtime:

```sh
HERMES_LIVE_PROVIDER=openai \
OPENAI_API_KEY=... \
OPENAI_REALTIME_MODEL=gpt-realtime-2.1 \
OPENAI_REALTIME_TURN_DETECTION=disabled \
HERMES_AGENT_API_SERVER_KEY=... \
HERMES_LIVE_AUTH_TOKEN=local-test-token \
hermes-live serve
```

Use an isolated test identity and workspace. A live smoke can execute real Hermes tools and incur both Hermes model and realtime-provider usage.

## 4. Prove Background Delegation

Open the Dashboard or demo and send text before enabling the microphone. Ask for a concrete task that requires Hermes, such as inspecting a disposable repository and running read-only checks.

Required evidence:

1. `session.ready` negotiates protocol v3 and a `task.snapshot` follows.
2. The task receives a stable `task_<id>` and `task.accepted` quickly, before Hermes completes.
3. The provider conversation remains responsive while the task is active.
4. Lifecycle advances through `task.started`/bounded progress to a truthful terminal state.
5. The durable inbox shows the same task once; upstream run ids and raw Hermes events are absent.
6. `task.get` returns the exact retained result; list/reconnect snapshots remain summary-only.

Then exercise supervision:

- with the default configuration, submit two tasks and confirm they serialize;
- restart with `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true`, then submit provably read-only tasks with disjoint resource keys and confirm they can overlap;
- with that opt-in still enabled, submit work sharing a resource key and confirm it serializes;
- submit an exclusive task and confirm it runs alone;
- stop one exact task while another continues;
- interrupt provider speech and confirm background tasks do not stop;
- close the tab/terminal and confirm tasks continue.

Do not use destructive targets to test these rules.

## 5. Prove Reconnect And Recovery

### Client reconnect

Disconnect during a long task, reconnect with the same owner scope, and verify:

- the initial `task.snapshot` restores the task;
- no duplicate task is created;
- newer lifecycle events win by `(taskId, sequence)`;
- a terminal notification appears if completion happened while disconnected;
- exact acknowledgement persists across another reconnect.

### Gateway restart

With Hermes Agent still running:

1. start a long task and record its public task id;
2. stop only the Hermes Live gateway;
3. restart it with the same state file/volume and configuration;
4. reconnect the same owner;
5. confirm the supervisor reconciles the persisted upstream run and reaches the true outcome.

This is the gateway-restart durability claim.

### Hermes restart limitation

Only in a disposable environment, restart Hermes Agent during work. Reconnect/restart the gateway and verify a confirmed missing upstream run becomes `task.unknown` and releases capacity. Do not expect completion recovery: current Hermes run state is process-local.

Audit any external effects before retrying. `unknown` is intentionally neither failed nor completed.

### Ambiguous dispatch

Use a fault-injection fixture, not a real mutation, to drop the run-creation response after Hermes may have accepted it. Verify the task becomes `task.unknown`, is not automatically retried, and fences later admission according to the scheduler rules. Follow [operator recovery](background-tasks.md#ambiguous-dispatch-fence); never edit the state to queued.

## 6. Prove Notifications

Complete tasks while the conversation is idle and while the user/provider is speaking.

Common requirements:

- `task.notification` is durable and owner-scoped;
- speech waits until idle and never replaces the inbox;
- announcement text is generic and does not inject task output into a new provider turn;
- exact task details are fetched only when requested;
- `task.notification.ack` acknowledges only the matching task/notification id.

Provider-specific evidence:

- **OpenAI:** verify completion requests an audio-only response with `conversation: "none"`, empty input, no tools, and does not append a conversational item. The user should hear one short announcement.
- **Gemini:** verify the authenticated task marker uses realtime text input. Speech is best-effort; absence or reordering of a spoken notice must not lose the durable UI notification.

## 7. Prove Approval Containment

In a safe fixture, make Hermes request approval. Verify:

- no approval message, button, choice, or terminal command appears;
- the gateway attempts deny-all;
- the exact task moves to stopping and is stopped/contained;
- other tasks are not stopped by inference;
- the provider explains only that approval is unavailable through Hermes Live.

Do not advertise interactive approvals even if the Hermes capability object includes run-scoped approval support; it lacks safe per-request identity for concurrent controllers.

## 8. Prove Audio And Interruption

After text/task flow passes:

- grant and deny microphone permission;
- verify the negotiated PCM sample rates and actual capture MIME type;
- verify provider audio playback and autoplay recovery;
- interrupt before playback, during playback, and after playback;
- verify `response.cancel` never maps to task stop;
- with OpenAI VAD, verify `input.speech_started` stops local playback and sends cancellation/truncation;
- verify OpenAI truncation includes `0` ms for queued-but-unheard audio when appropriate;
- test reconnect after network loss and provider close.

The browser helper supports PCM16 and intentionally rejects G.711 output.

## 9. Negative HTTP/Auth Cases

With gateway auth configured, unauthenticated capabilities should return 401:

```sh
curl -i http://127.0.0.1:8788/v1/capabilities
```

Authenticated readiness should return 200 when healthy:

```sh
curl -i -H "Authorization: Bearer local-test-token" \
  http://127.0.0.1:8788/ready
```

Health remains public:

```sh
curl -i http://127.0.0.1:8788/health
```

Also verify wrong origin, wrong token, oversized messages, malformed known events, unsupported protocol v2, provider startup timeout, Hermes SSE idle timeout, and state-file permission/corruption failures all fail visibly without exposing secrets.

## Provider Notes

OpenAI's server-side Realtime WebSocket fits this gateway because provider credentials remain on the server. `OPENAI_REALTIME_TURN_DETECTION=disabled` uses client `audio.end`; `semantic_vad` and `server_vad` delegate boundaries to OpenAI. The gateway does not implicitly enable OpenAI's separately billed spoken-input transcription model.

Gemini Live expects raw PCM and returns raw PCM. The gateway normalizes sample rates, but clients must report their true capture rate. Gemini 3.1 mid-session text uses realtime input; `sendClientContent` remains an SDK compatibility fallback for initial history behavior.

The Gemini adapter is a single-connection preview path without context-window compression, session resumption, or `GoAway` migration. A durable Hermes task can outlive that provider connection, but the Gemini conversation itself is not indefinite. Test the session duration required by your deployment.

## What This Does Not Prove

- multi-tenant authorization or per-user quotas;
- multi-node gateway failover or shared durable storage;
- provider quota, latency, regional availability, or long-session behavior beyond the test window;
- recovery of in-progress work across a Hermes Agent restart;
- microphone/audio behavior on browsers and devices not manually tested;
- reversibility of Hermes side effects.

References:

- [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime)
- [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [OpenAI Realtime WebSocket](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api)
- [Gemini Live session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)
