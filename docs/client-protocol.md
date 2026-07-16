# Client Protocol

Hermes Live protocol v3 is strict JSON over WebSocket:

```txt
ws://127.0.0.1:8788/v1/live
```

Use `wss://` behind TLS for non-local clients. Protocol v3 is a breaking replacement for the old synchronous run lifecycle: every client must send `protocolVersion: 3`, and the gateway exposes stable server-owned tasks rather than upstream Hermes run ids.

The TypeScript schemas in `src/domain/protocol/` and the browser validator in `clients/browser/hermes-live-client.js` are the normative contract.

## Authentication

When `HERMES_LIVE_AUTH_TOKEN` is configured, authenticate:

- `WS /v1/live`
- `GET /ready`
- `GET /v1/capabilities`

Server-side clients should send:

```txt
Authorization: Bearer <token>
```

Direct browser WebSockets that cannot set upgrade headers may use `/v1/live?token=<token>`. Treat that URL as a secret. Production browser integrations should instead use an authenticated same-origin WebSocket relay, as the Hermes Dashboard plugin does. `GET /health` stays public for health probes.

## Session Negotiation

The first client message must be:

```json
{
  "type": "session.start",
  "id": "start_1",
  "protocolVersion": 3
}
```

Optional `profileId` and `userLabel` values are ignored unless the operator enables trusted client identity. The gateway rejects missing or unsupported versions before opening a provider session.

On success, the server sends `session.ready` followed by one or more bounded initial/reconnect snapshot frames:

```json
{
  "type": "session.ready",
  "protocolVersion": 3,
  "requestId": "start_1",
  "sessionId": "live_...",
  "model": "gpt-realtime-2.1",
  "hermes": {
    "model": "hermes-agent",
    "capabilities": {
      "run_submission": true,
      "run_status": true,
      "run_events_sse": true,
      "run_stop": true
    }
  },
  "realtime": {
    "provider": "openai",
    "model": "gpt-realtime-2.1",
    "audio": {
      "input": { "enabled": true, "mimeType": "audio/pcm;rate=24000", "recommendedFrameMs": 50 },
      "output": { "enabled": true, "mimeType": "audio/pcm;rate=24000" },
      "turnDetection": "disabled"
    }
  },
  "tasks": {
    "scope": "owner",
    "sequence": "per_task",
    "reconnect": "snapshot",
    "durable": true,
    "parallel": false,
    "maxConcurrent": 3,
    "maxRetained": 200,
    "supports": {
      "list": true,
      "get": true,
      "stop": true,
      "resume": false,
      "notificationAck": true
    }
  }
}
```

Provider/model/audio values are negotiated, not constants. Mock mode reports audio disabled. `tasks.parallel` becomes true only when the operator enables trusted model-declared read-only scopes. Clients must not send or decode a codec that `session.ready` did not advertise.

The following snapshot shape establishes the owner's current inbox:

```json
{
  "type": "task.snapshot",
  "reason": "reconnect",
  "tasks": [],
  "truncated": false
}
```

Each frame contains at most 100 tasks. Reconnect hydration always includes every retained active task and every unread notification, even when they sit behind newer terminal history; the gateway emits additional bounded frames when necessary. `truncated: true` means older read terminal history was omitted from the recent view, not that active or unread work was dropped and not that the message contains a pagination cursor.

## Conversation Messages

Text input:

```json
{ "type": "text.input", "id": "text_1", "text": "Inspect the repository and run its tests" }
```

PCM audio frame:

```json
{
  "type": "audio.input",
  "data": "<base64>",
  "mimeType": "audio/pcm;rate=24000"
}
```

End a push-to-talk stream:

```json
{ "type": "audio.end", "id": "audio_end_1" }
```

The realtime provider may answer directly or call `start_background_task`. There is deliberately no client `task.start`: task creation goes through the provider's narrow delegation tool and returns a fast receipt so conversation can continue.

Server conversation events are:

- `transcript.delta` with `speaker`, `text`, and optional `final`;
- `audio.output` with base64 data, MIME type, and optional playback correlation;
- `input.speech_started` for OpenAI VAD;
- `response.started`, `response.completed`, `response.cancelled`, and `response.failed`;
- bounded `log` and `session.error` messages.

## Task Controls

All task controls require a unique request `id`. They are owner-scoped; a valid-looking task id owned by another scope is treated as not found.

List recent tasks:

```json
{ "type": "task.list", "id": "list_1", "limit": 50 }
```

The response is a correlated snapshot with `reason: "list"`. `limit` defaults to 50 and cannot exceed 100. `truncated` is true only when at least one additional recent record exists beyond the requested limit.

Fetch one exact task, including retained output when completed:

```json
{ "type": "task.get", "id": "get_1", "taskId": "task_0123456789abcdef0123456789abcdef" }
```

The response has `reason: "get"`, the same `requestId`, and zero or one task. An empty array means no task in this owner scope was found.

Stop exactly one task:

```json
{
  "type": "task.stop",
  "id": "stop_1",
  "taskId": "task_0123456789abcdef0123456789abcdef",
  "reason": "User cancelled this task"
}
```

A queued task can become `task.cancelled` immediately. An active task normally emits `task.stopping` and remains non-terminal until Hermes confirms completion, failure, or cancellation. A stop with an ambiguous upstream outcome becomes `task.unknown`; the gateway never stops a different task by inference.

## Task Lifecycle

Lifecycle events have a stable `taskId`, a positive per-task `sequence`, and `occurredAt` in Unix milliseconds. Examples:

```json
{
  "type": "task.accepted",
  "taskId": "task_0123456789abcdef0123456789abcdef",
  "sequence": 1,
  "occurredAt": 1780000000000,
  "state": "queued",
  "title": "Inspect repository"
}
```

```json
{
  "type": "task.progress",
  "taskId": "task_0123456789abcdef0123456789abcdef",
  "sequence": 4,
  "occurredAt": 1780000001200,
  "progress": { "message": "Hermes completed a tool." }
}
```

```json
{
  "type": "task.completed",
  "taskId": "task_0123456789abcdef0123456789abcdef",
  "sequence": 8,
  "occurredAt": 1780000010000,
  "result": {
    "summary": "Repository checks passed.",
    "output": "Repository checks passed.",
    "truncated": false
  }
}
```

The lifecycle types are:

- `task.accepted`
- `task.started`
- `task.progress`
- `task.stopping`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.unknown`

Public snapshots use states `accepted`, `queued`, `running`, `stopping`, `completed`, `failed`, `cancelled`, or `unknown`. Internal Hermes run ids, raw SSE events, reasoning, tool arguments, and approval identities are never exposed.

List/reconnect snapshots omit full completed output and mark it truncated from that view; use `task.get` for retained output. A connected owner also receives bounded output on the live `task.completed` event.

## Ordering And Reconnect

`sequence` is monotonic within one task, not a global cursor. Task delivery has two independent per-task revision channels:

- Lifecycle state comes from `task.snapshot` and lifecycle events. Retain its latest sequence and content by `taskId`.
- Notification state comes from `task.notification`. Retain its latest sequence, `notificationId`, and acknowledgement state by `taskId`; a later revision can acknowledge the same notification or replace a superseded notice with a new identity.

A lifecycle event and `task.notification` may intentionally carry the same `(taskId, sequence)`. They are complementary projections, not duplicates, and either can arrive first. A client must not use one shared last-sequence gate that discards the second projection.

Within each channel, accept a newer sequence and treat an exact equal-sequence replay as idempotent. Conflicting content repeated at the same sequence in the same channel is a protocol error and must fail closed. Then:

1. key task state by `taskId` while retaining separate lifecycle and notification revisions;
2. clear stale cached active state on the first reconnect frame, then merge every bounded reconnect frame by task id;
3. never infer task cancellation from socket closure.

The shared browser client implements these rules. Task execution continues when a client or provider disconnects. Gateway-restart recovery is possible only while the upstream Hermes process still knows the persisted run id; see [Durable Background Tasks](background-tasks.md#persistence-and-recovery).

## Notifications

Terminal outcomes produce a durable owner-scoped notification:

```json
{
  "type": "task.notification",
  "taskId": "task_0123456789abcdef0123456789abcdef",
  "sequence": 8,
  "occurredAt": 1780000010000,
  "notification": {
    "notificationId": "notification_task_0123456789abcdef0123456789abcdef_8",
    "kind": "completed",
    "delivery": "when_idle",
    "message": "“Inspect repository” completed.",
    "createdAt": 1780000010000,
    "acknowledged": false
  }
}
```

Kinds are `completed`, `failed`, `cancelled`, and `unknown`. Acknowledge only the exact unread notification currently presented:

```json
{
  "type": "task.notification.ack",
  "id": "ack_1",
  "taskId": "task_0123456789abcdef0123456789abcdef",
  "notificationId": "notification_task_0123456789abcdef0123456789abcdef_8"
}
```

The response is another `task.notification` carrying `requestId: "ack_1"` and `acknowledged: true`. A spoken announcement and a UI acknowledgement are separate: speech is best-effort, while notification state is durable. If an `unknown` task later re-enters recovery, the gateway sends the old notification identity with `acknowledged: true` to withdraw that superseded notice before publishing any later terminal notification.

## Speech Interruption Versus Task Stop

Cancel the current provider response without touching tasks:

```json
{
  "type": "response.cancel",
  "id": "cancel_1",
  "reason": "user interrupted",
  "truncate": {
    "itemId": "item_...",
    "contentIndex": 0,
    "audioEndMs": 420
  }
}
```

OpenAI uses the optional truncation metadata to keep provider conversation history aligned with what the user actually heard. Gemini handles speech interruption through live audio activity and does not expose an equivalent direct cancel event.

Detach cleanly:

```json
{ "type": "session.close", "id": "close_1", "detach": true }
```

An ordinary WebSocket close has the same task-lifetime rule: background work remains server-owned. Only `task.stop` cancels a task.

## Browser Client

`hermes-live-voice/browser` is the framework-independent client used by the demo and Dashboard integration:

```js
import { HermesLiveAudio, HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  webSocketUrlProvider: async () => {
    const response = await fetch("/api/hermes-live/socket", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Live Voice is unavailable");
    return (await response.json()).url;
  },
});

client.subscribe(({ tasks, unreadNotifications }) => renderInbox(tasks, unreadNotifications));
client.on("transcript.delta", renderTranscript);
client.on("task.completed", renderTaskUpdate);
client.on("task.notification", renderNotification);
client.on("error", renderError);

const audio = new HermesLiveAudio(client, { workletUrl: "/mic-worklet.js" });
await client.connect();
client.sendText("Inspect this repository while we discuss the next task");
```

Task methods return their generated request id:

```js
client.listTasks({ limit: 50 });
client.getTask(taskId);
client.stopTask(taskId, "user cancelled");
client.acknowledgeNotification(taskId, notificationId);
```

`sendAudio()` emits `audio.dropped` if browser backpressure is exceeded. Unknown future server types emit `unknownmessage`; malformed known messages close the connection rather than corrupt local state.

## HTTP Readiness And Capabilities

`GET /ready` reports gateway, Hermes, provider, and task-store readiness. A healthy response does not open a live provider session; `checks.realtime.sessionChecked` remains `false`.

`GET /v1/capabilities` reports protocol version, audio contract, task persistence/admission limits, disconnect continuation, restart semantics, ambiguity fencing, and feature flags. `hermes_approval` and `hermes_approval_ui` are false; the advertised fallback is deny-all then stop.

## Limits And Errors

Protocol fields are bounded before dispatch: ids, identity strings, reasons, MIME types, text, audio, task snapshots, results, usage, notifications, logs, and provider messages all have hard ceilings. PCM input must declare one integer sample rate between 8,000 and 192,000 Hz. Browser audio currently supports PCM16; it rejects G.711 output rather than misdecoding it.

Errors use:

```json
{
  "type": "session.error",
  "code": "unsupported_protocol_version",
  "message": "Hermes Live protocol v2 is incompatible with protocol v3. Upgrade hermes-live-voice and every connected client to the same release before reconnecting.",
  "requestId": "start_1",
  "recoverable": false
}
```

When a request has an `id`, validation or state failures echo it as `requestId`. Clients should show the bounded public message and use gateway logs for private diagnostics.
