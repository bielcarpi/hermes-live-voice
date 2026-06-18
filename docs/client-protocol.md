# Client Protocol

The public client protocol is JSON over WebSocket.

```txt
ws://127.0.0.1:8788/v1/live
```

Use `wss://` behind TLS in production.

For a one-shot terminal smoke test, use:

```sh
hermes-live client "What is the current status?"
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

## Start Session

The first message must be `session.start`.

```json
{
  "type": "session.start",
  "profileId": "default",
  "userLabel": "alice"
}
```

The server replies:

```json
{
  "type": "session.ready",
  "sessionId": "live_...",
  "model": "gpt-realtime-2",
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
  "mimeType": "audio/pcm;rate=24000"
}
```

Transcript:

```json
{
  "type": "transcript.delta",
  "speaker": "assistant",
  "text": "I am checking Hermes now."
}
```

Hermes run started:

```json
{
  "type": "run.started",
  "runId": "run_...",
  "sessionId": "live_..."
}
```

Hermes run event:

```json
{
  "type": "run.event",
  "runId": "run_...",
  "event": {
    "event": "message.delta",
    "delta": "..."
  }
}
```

Hermes completion:

```json
{
  "type": "run.completed",
  "runId": "run_...",
  "output": "..."
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

## Close

```json
{
  "type": "session.close"
}
```

Closing the WebSocket also closes the provider session and asks Hermes to stop any active run.
