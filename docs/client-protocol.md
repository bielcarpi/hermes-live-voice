# Client Protocol

The public client protocol is JSON over WebSocket.

```txt
ws://127.0.0.1:8788/v1/live
```

Use `wss://` behind TLS in production.

For a one-shot terminal smoke test, use:

```sh
node dist/cli.js client "What is the current status?"
```

## Authentication

If `HERMES_LIVE_AUTH_TOKEN` is configured, clients must authenticate to:

- `WS /v1/live`
- `GET /ready`
- `GET /v1/capabilities`

`GET /health` remains public so load balancers and container health checks can probe the process without receiving gateway credentials.

For HTTP endpoints and clients that can set headers:

```txt
Authorization: Bearer <token>
```

Only for browser WebSocket clients that cannot set upgrade headers:

```txt
/v1/live?token=<token>
```

Query-token auth is not accepted for `/ready` or `/v1/capabilities`.

## HTTP Readiness

`GET /ready` returns the same gateway, Hermes, and realtime readiness sections as `node dist/cli.js check`.

```json
{
  "status": "ready",
  "checks": {
    "gateway": { "ok": true, "authRequired": true },
    "hermes": { "ok": true, "baseUrl": "http://127.0.0.1:8642" },
    "realtime": {
      "ok": true,
      "configured": true,
      "provider": "openai",
      "model": "gpt-realtime-2.1",
      "sessionChecked": false
    }
  }
}
```

When any section is not ready, the endpoint returns `503` with that section's `error`.
`sessionChecked: false` means readiness verified provider configuration, not a live Gemini/OpenAI session handshake.

## Client Limits

Client message metadata such as request IDs, profile IDs, user labels, run IDs, MIME types, cancellation reasons, and playback truncation fields is bounded by the protocol before dispatch. Text input and provider tool-call text use `HERMES_LIVE_MAX_TEXT_CHARS`; audio frames use `HERMES_LIVE_MAX_AUDIO_BYTES`.

## Request IDs

Every client message can include an optional `id` string. When that message causes a `session.error`, the gateway echoes it as `requestId` so browser, mobile, and terminal clients can correlate recoverable validation or session-state failures.

```json
{
  "type": "text.input",
  "id": "req_123",
  "text": "What changed?"
}
```

## Start Session

The first message must be `session.start`.

```json
{
  "type": "session.start",
  "profileId": "default",
  "userLabel": "alice"
}
```

The gateway owns Hermes memory identity by default. It uses `HERMES_LIVE_PROFILE_ID` and `HERMES_LIVE_USER_LABEL`, ignoring the two client fields above. Set `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true` only for a trusted-client deployment where clients are intentionally allowed to select Hermes memory scopes.

The server replies:

```json
{
  "type": "session.ready",
  "sessionId": "live_...",
  "model": "gpt-realtime-2.1",
  "hermes": {
    "model": "hermes-agent"
  }
}
```

## Audio Input

Send base64 PCM16 frames.

```json
{
  "type": "audio.input",
  "data": "<base64>",
  "mimeType": "audio/pcm;rate=24000"
}
```

End the current stream:

```json
{
  "type": "audio.end"
}
```

For OpenAI Realtime with `OPENAI_REALTIME_TURN_DETECTION=disabled`, `audio.end` commits the input buffer and triggers a response. With OpenAI VAD enabled, provider turn detection owns that timing and `audio.end` is treated as a no-op by the OpenAI adapter.

## Cancel Provider Speech

Cancel the current realtime provider response before sending an interruption or new input:

```json
{
  "type": "response.cancel",
  "reason": "user interrupted"
}
```

This is a best-effort provider cancellation. OpenAI Realtime maps it to `response.cancel`. Gemini Live handles barge-in through live audio activity, so the current Gemini adapter accepts this message without sending a dedicated provider cancel event.

For OpenAI WebSocket playback, include truncation metadata when the user interrupts audio that has already started playing:

```json
{
  "type": "response.cancel",
  "reason": "user interrupted",
  "truncate": {
    "itemId": "item_...",
    "contentIndex": 0,
    "audioEndMs": 1200
  }
}
```

`audioEndMs` should be the number of milliseconds of that assistant audio item actually heard by the user. The gateway maps this to OpenAI's `conversation.item.truncate` event.
Use `0` when the item has already been queued by the browser but none of that item has reached the user's speakers yet.

## Text Input

Text input is useful for smoke tests and accessibility.

```json
{
  "type": "text.input",
  "text": "What changed in this repository?"
}
```

## Output Events

Assistant audio:

```json
{
  "type": "audio.output",
  "data": "<base64>",
  "mimeType": "audio/pcm;rate=24000",
  "itemId": "item_...",
  "contentIndex": 0
}
```

`itemId` and `contentIndex` are optional provider metadata. OpenAI Realtime clients can use them to truncate unplayed assistant audio during interruption.

Transcript:

```json
{
  "type": "transcript.delta",
  "speaker": "assistant",
  "text": "I am checking Hermes now."
}
```

Provider-managed speech start:

```json
{
  "type": "input.speech_started",
  "provider": "openai",
  "itemId": "item_...",
  "audioStartMs": 320
}
```

OpenAI VAD can emit this when the provider detects user speech. Voice clients should stop local assistant playback immediately and send `response.cancel`. If queued assistant audio has provider item metadata, include `truncate` so the gateway can remove unheard audio from the provider conversation.

Raw realtime provider message:

```json
{
  "type": "realtime.message",
  "message": {
    "type": "response.done"
  }
}
```

Clients usually do not need to show raw provider messages. They are useful for debugging and provider-specific telemetry.

Hermes run started:

```json
{
  "type": "run.started",
  "runId": "run_...",
  "sessionId": "live_..."
}
```

Hermes run event (safe summary by default):

```json
{
  "type": "run.event",
  "runId": "run_...",
  "event": {
    "event": "tool.started",
    "run_id": "run_...",
    "timestamp": 1710000000
  }
}
```

`HERMES_LIVE_RUN_EVENT_DETAIL=summary` forwards only allowlisted scalar metadata. `none` suppresses `run.event` messages. `raw` forwards upstream Hermes event payloads and should be used only with trusted developer clients because those events can contain tool arguments, output, paths, or error detail.

Hermes completion:

```json
{
  "type": "run.completed",
  "runId": "run_...",
  "output": "..."
}
```

Hermes run failed:

```json
{
  "type": "run.failed",
  "runId": "run_...",
  "error": "Hermes run failed."
}
```

Session-level error:

```json
{
  "type": "session.error",
  "code": "provider_error",
  "message": "Realtime provider failed before session ready.",
  "requestId": "req_123",
  "recoverable": false
}
```

## Approvals

When Hermes asks for approval, the gateway emits:

```json
{
  "type": "approval.request",
  "runId": "run_...",
  "event": {
    "event": "approval.request"
  }
}
```

The client responds:

```json
{
  "type": "approval.respond",
  "runId": "run_...",
  "choice": "once"
}
```

Valid choices:

- `once`
- `session`
- `always`
- `deny`

After the gateway submits the decision to Hermes, it emits:

```json
{
  "type": "approval.responded",
  "runId": "run_...",
  "choice": "once",
  "resolved": 1
}
```

## Stop

Stop the active run:

```json
{
  "type": "run.stop",
  "reason": "user interrupted"
}
```

The server emits:

```json
{
  "type": "run.stopped",
  "runId": "run_...",
  "status": "stopping"
}
```

## Logs

The gateway can emit operational logs to help clients explain non-terminal events:

```json
{
  "type": "log",
  "level": "info",
  "message": "Hermes run stop requested",
  "data": {
    "runId": "run_..."
  }
}
```

## Close

```json
{
  "type": "session.close"
}
```

Closing the WebSocket also closes the provider session and asks Hermes to stop any active run.
