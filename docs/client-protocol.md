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

For a persistent text-control session, use `hermes-live terminal`. It exercises this same protocol while exposing task progress, provider interruption, Hermes task stop, and targeted approvals as terminal commands. Approval commands are enabled only when Hermes advertises `run_approval_response_by_id` and supplies a stable ID for the request. With a legacy uncorrelated approval contract, the terminal shows no actionable approval prompt; the gateway attempts to deny the pending queue, stops the Hermes run, and closes the voice session for operator verification. The terminal intentionally has no native audio dependency: use official Hermes Voice Mode (Ctrl+B) for a local microphone, or the Dashboard/browser client for remote gateway audio.

From a built source checkout, replace `hermes-live` with `node dist/cli.js`.

## Browser Client

`hermes-live-voice/browser` is the canonical framework-independent browser client. It has no Node, provider SDK, or UI-framework runtime dependencies. The bundled web demo consumes the same module that is included in the packed npm artifact.

```js
import { HermesLiveAudio, HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  url: "wss://voice.example.com/v1/live",
  token: async () => getShortLivedToken(),
  profileId: "default",
  userLabel: "browser",
});

client.on("transcript.delta", ({ speaker, text }) => renderTranscript(speaker, text));
client.on("approval.request", renderApproval);
client.on("error", ({ code, error }) => renderError(code, error.message));

await client.connect();
client.sendText("Inspect this repository");
```

Every command method returns its generated request ID. `sendAudio()` returns `undefined` and emits `audio.dropped` when the browser WebSocket exceeds the configured backpressure limit. Unknown future server message types emit `unknownmessage`; malformed known lifecycle messages close the connection instead of corrupting local state.

For microphone capture and PCM16 playback, compose `HermesLiveAudio` with a worklet URL owned by the host application. The gateway serves it at `/mic-worklet.js`, and the package exposes the source as `hermes-live-voice/browser/mic-worklet.js` for clients that copy or bundle static assets. Playback is serialized and bounded, and `interrupt()` returns OpenAI-compatible truncation metadata before sending `response.cancel`.

The browser audio helper intentionally rejects G.711 output rather than decoding it as PCM16. Keep `OPENAI_REALTIME_INPUT_AUDIO_FORMAT=pcm16` and `OPENAI_REALTIME_OUTPUT_AUDIO_FORMAT=pcm16` for browser voice clients until a client explicitly implements negotiated G.711 codecs.

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

`GET /ready` returns the same gateway, Hermes, and realtime readiness sections as `hermes-live check`.

```json
{
  "status": "ready",
  "checks": {
    "gateway": { "ok": true, "authRequired": true },
    "hermes": {
      "ok": true,
      "baseUrl": "http://127.0.0.1:8642",
      "approvals": {
        "uiSupported": true,
        "interactive": false,
        "fallback": "deny_all_then_stop",
        "requiredFeature": "run_approval_response_by_id",
        "negotiated": true
      }
    },
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

`GET /v1/capabilities` exposes the same approval object at `hermes.approvals`; readiness exposes it at `checks.hermes.approvals`. Approval UI support and safe upstream approval submission are separate capabilities. `uiSupported: true` means this gateway and its bundled clients implement approval controls. `interactive: true` is reported only after Hermes advertises `run_approval_response_by_id`. Otherwise uncorrelated approval requests use the `deny_all_then_stop` fail-closed fallback: the gateway attempts denial, stops the run, and closes the voice session instead of exposing positive choices. `negotiated: false` means the upstream capability probe itself did not complete, not that approval was implicitly enabled.

## Client Limits

Client message metadata such as request IDs, profile IDs, user labels, run IDs, MIME types, cancellation reasons, and playback truncation fields is bounded by the protocol before dispatch. Text input and provider tool-call text use `HERMES_LIVE_MAX_TEXT_CHARS`; audio frames use `HERMES_LIVE_MAX_AUDIO_BYTES`. PCM16 input must declare one integer `rate=` between 8,000 and 192,000 Hz. Resampling validates its target and refuses any calculated output above the 16 MiB allocation ceiling before allocating memory.

The reverse path is bounded too. Provider transcript deltas, provider audio frames, retained Hermes output, usage payloads, raw run events, pre-ready provider events, and per-client WebSocket buffering all have hard ceilings. A provider that violates its negotiated output contract or a client that stops draining data is disconnected rather than allowed to grow process memory without bound.

| Boundary | Default or hard ceiling |
| --- | --- |
| Client text | `HERMES_LIVE_MAX_TEXT_CHARS` (20,000; configurable up to 1,000,000) |
| Decoded client/provider audio frame | `HERMES_LIVE_MAX_AUDIO_BYTES` (2,000,000; configurable up to 5,900,000) |
| Queued inbound client messages | 256 messages / 8 MiB |
| Pre-ready provider events | 256 events / 8 MiB |
| Provider transcript delta | 20,000 characters |
| Retained Hermes output | 200,000 characters |
| Public raw run-event payload | 256,000 bytes |
| Public usage payload | 64,000 bytes |
| Individual provider tool response | 256,000 bytes; 4 MiB aggregate replay cache |
| Browser inbound message | 8,000,000 bytes by default |
| Browser queued playback | five seconds by default |

Limits are protocol safety boundaries, not recommended application payload sizes.

## Request IDs

Every client message can include an `id` string. It is required for the mutating `approval.respond` message and optional elsewhere. When a message causes a `session.error`, the gateway echoes it as `requestId` so browser, mobile, and terminal clients can correlate validation or session-state failures.

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
  "protocolVersion": 2,
  "profileId": "default",
  "userLabel": "alice"
}
```

The gateway owns Hermes memory identity by default. It uses `HERMES_LIVE_PROFILE_ID` and `HERMES_LIVE_USER_LABEL`, ignoring the two client fields above. Set `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true` only for a trusted-client deployment where clients are intentionally allowed to select Hermes memory scopes.

The server replies:

```json
{
  "type": "session.ready",
  "protocolVersion": 2,
  "sessionId": "live_...",
  "model": "gpt-realtime-2.1",
  "hermes": {
    "model": "hermes-agent",
    "capabilities": {
      "run_approval_response_by_id": true
    }
  },
  "realtime": {
    "provider": "openai",
    "model": "gpt-realtime-2.1",
    "audio": {
      "input": {
        "enabled": true,
        "mimeType": "audio/pcm;rate=24000",
        "recommendedFrameMs": 50
      },
      "output": {
        "enabled": true,
        "mimeType": "audio/pcm;rate=24000"
      },
      "turnDetection": "disabled"
    }
  }
}
```

The current protocol version is `2`. Every client must send `protocolVersion: 2`; the gateway rejects missing or unsupported versions before opening a provider session. Protocol v2 is a breaking negotiation change: it makes approval correlation explicit, removes raw provider envelopes, and adds `run.stopping`. The `/v1/live` URL is retained as the endpoint path; it is not the protocol-version negotiation field. Clients must use the negotiated audio contract in `session.ready` rather than assume every deployment uses PCM16.

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

This is a best-effort provider cancellation. OpenAI Realtime maps it to `response.cancel`, waits for the terminal response event before creating a queued follow-up response, and closes the provider session if cancellation is not acknowledged within a bounded deadline. Gemini Live handles barge-in through live audio activity, so the current Gemini adapter accepts this message without sending a dedicated provider cancel event.

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

Provider-neutral response lifecycle:

```json
{ "type": "response.started", "responseId": "resp_..." }
{ "type": "response.completed", "responseId": "resp_..." }
{ "type": "response.cancelled", "responseId": "resp_..." }
{ "type": "response.failed", "responseId": "resp_...", "error": "Realtime response failed." }
```

`responseId` is optional because not every provider exposes one. Raw provider payloads are intentionally not forwarded: audio and lifecycle data are emitted only through these normalized messages so audio bytes are not duplicated and provider internals do not leak into clients.

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

`HERMES_LIVE_RUN_EVENT_DETAIL=summary` forwards only allowlisted scalar metadata. `none` suppresses `run.event` messages. `raw` forwards upstream Hermes event payloads up to a 256,000-byte event-payload ceiling and replaces larger events with a bounded summary carrying `truncated: true`. Raw mode should still be used only with trusted developer clients because events below that ceiling can contain tool arguments, output, paths, or error detail.

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

The examples in this section are the targeted-capable case. The gateway emits `approval.request` only after Hermes advertises `run_approval_response_by_id: true` and the corresponding upstream event contains a stable, bounded `approval_id`:

```json
{
  "type": "approval.request",
  "runId": "run_...",
  "event": {
    "event": "approval.request"
  },
  "approval": {
    "approvalId": "approval_...",
    "command": "git push origin feature",
    "description": "This command changes a remote repository.",
    "patternKey": "git_push",
    "choices": ["once", "session", "always", "deny"],
    "allowPermanent": true
  }
}
```

If the capability is absent or false, or an event omits a valid stable ID, the gateway does not create an actionable approval envelope. It attempts the legacy `deny_all` operation, then stops the run and emits a fatal error before closing the voice session even when denial was confirmed:

```json
{
  "type": "session.error",
  "code": "hermes_approval_identity_unsupported",
  "message": "Interactive approval is unavailable because this Hermes version cannot correlate requests safely. The pending queue was denied, the run is being stopped, and the voice session is closing. Verify the run in Hermes before retrying.",
  "recoverable": false
}
```

Clients must preserve this fatal status after socket close and must not synthesize an `approvalId`, render positive approval controls, or send `approval.respond`. This containment is intentionally terminal because Hermes' FIFO response contract cannot prove that a visible request was the action denied when another client may respond concurrently.

Hermes redacts credentials from approval commands before they enter its Runs API event stream. Hermes Live then projects only exact, bounded display values. If a supplied command, description, choice list, or permission pattern would need transformation, truncation, or control-character removal, the request is narrowed rather than silently repaired. A request with incomplete display context is deny-only. An informed request without an exact inspectable permission pattern can offer only `once` or `deny`. `session` and `always` require a visible exact `patternKey` or `patternKeys`, and clients must never invent wider choices.

The gateway assigns every envelope an opaque gateway-owned `approvalId`, correlates it to Hermes' bounded upstream approval id, and retains envelopes server-side in FIFO order. It accepts a response only when the exact `runId` and `approvalId` match the active queue head and `choice` was offered in that envelope. `always` additionally requires `allowPermanent: true`. Protocol v2 rejects `resolveAll: true`; clients must answer each request explicitly. Approval request IDs are cached in a bounded idempotency window: an exact duplicate replays its prior acknowledgement without another Hermes mutation, while request-ID reuse with different data is rejected. Duplicate or mutated upstream approval identities fail closed. If Hermes' approval POST outcome cannot be confirmed, the gateway stops the run and closes the session rather than risk applying a retry to the next action.

The client responds:

```json
{
  "type": "approval.respond",
  "id": "approval_response_123",
  "runId": "run_...",
  "approvalId": "approval_...",
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
  "requestId": "approval_response_123",
  "runId": "run_...",
  "approvalId": "approval_...",
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

The server first confirms that a stop was requested without claiming the run is terminal:

```json
{
  "type": "run.stopping",
  "runId": "run_...",
  "status": "stopping"
}
```

Only Hermes `run.cancelled` emits `run.stopped`. Normal and failed terminal states emit `run.completed` and `run.failed`. Clients must keep the run in a stopping state until one of those terminal messages arrives.

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

For an orderly client shutdown, send `session.close` and wait for the server's WebSocket close instead of immediately starting a client close handshake. Code `1000` confirms gateway cleanup completed. `session_shutdown_unconfirmed` followed by code `1011`, or a client-side shutdown timeout, means cleanup could not be confirmed and the user must verify any active task directly in Hermes.
