# Client Protocol

The public client protocol is JSON over WebSocket.

```txt
ws://127.0.0.1:8788/v1/live
```

Use `wss://` behind TLS in production.

## Authentication

If `HERMES_LIVE_AUTH_TOKEN` is configured, clients must authenticate to:

- `WS /v1/live`
- `GET /ready`
- `GET /v1/capabilities`

`GET /health` remains public so load balancers and container health checks can probe the process without receiving gateway credentials.

Preferred:

```txt
Authorization: Bearer <token>
```

For browser WebSocket clients that cannot set upgrade headers:

```txt
/v1/live?token=<token>
```

Avoid query-token auth outside browser WebSocket cases because URLs are easier to leak through logs and analytics.

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
  "sessionKey": "agent:main:hermes-live:profile:default:user:alice",
  "model": "gpt-realtime-2",
  "hermes": {
    "baseUrl": "http://127.0.0.1:8642",
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
