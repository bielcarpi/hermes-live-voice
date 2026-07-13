# UI Integration

Hermes Live Voice is a gateway and client protocol, not one fixed application. The Live Voice plugin makes Hermes Dashboard the recommended end-user surface; the shared browser client is the integration surface for community and custom UIs; the terminal client is the remote/headless control surface. This describes compatibility with Hermes Dashboard, not an endorsement by the Hermes maintainers.

## Surface Matrix

| Surface | Current support | Intended use |
| --- | --- | --- |
| Hermes Dashboard + Live Voice plugin | First-class | Browser voice, text fallback, transcript, task activity, interruption, run stop, and approvals. |
| Bundled browser demo | First-class development tool | Local gateway setup and protocol troubleshooting. |
| `hermes-live-voice/browser` | First-class integration API | Custom/community browser, Electron, mobile-web, React, Vue, Svelte, or vanilla clients. |
| `hermes-live terminal` | First-class text control | SSH, headless hosts, remote operations, transcripts, task events, approvals, interruption, and stop. |
| Hermes Ctrl+B Voice Mode | Official Hermes feature | The shortest local terminal microphone path; not replaced by this project. |
| Generic OpenAI-compatible chat UI | Hermes chat only | Does not implement Hermes Live realtime audio, lifecycle, task, or approval events by itself. |

## Hermes Dashboard

Install and enable the plugin, run the companion gateway, and restart the Dashboard:

```sh
hermes plugins install bielcarpi/hermes-live-voice/plugins/hermes-live --enable
hermes dashboard
```

Choose **Live Voice** in the plugin navigation group.

The plugin contributes:

- `dashboard/manifest.json`, which registers the `/live-voice` tab;
- a responsive, theme-aware frontend using the shared browser client and microphone worklet;
- authenticated `/status` and `/live` plugin API routes;
- a server-side WebSocket relay to the companion gateway.

The browser talks only to same-origin Hermes Dashboard routes:

```txt
Dashboard browser
  -> Hermes-authenticated /api/plugins/hermes-live/live
  -> plugin_api.py
  -> Authorization: Bearer HERMES_LIVE_AUTH_TOKEN
  -> hermes-live gateway /v1/live
```

The backend delegates authentication and origin decisions to Hermes Dashboard's own request checks, fails closed when those checks are unavailable, applies bounded timeouts and message sizes, and never returns the gateway token or upstream origin in `/status`.

Set these values in the Dashboard server process when needed:

```sh
HERMES_LIVE_URL=https://voice.example.com
HERMES_LIVE_AUTH_TOKEN=your-random-gateway-token
```

`HERMES_LIVE_URL` must be a credential-free HTTP(S) origin. The Dashboard backend rejects user information, paths, query parameters, fragments, and WS(S) schemes. The token is a separate server-side value.

Hermes Live Voice v0.3.0 was manually exercised in the official `nousresearch/hermes-agent:latest` Docker image running Hermes Agent v0.18.2. Compatibility is also guarded by plugin manifest, Python backend, generated-asset, browser-client, package, and protocol tests.

## Custom Or Community Browser UI

Install the package after it is published, or consume the same exports from a GitHub checkout/package tarball:

```js
import { HermesLiveAudio, HermesLiveClient } from "hermes-live-voice/browser";

const client = new HermesLiveClient({
  webSocketUrlProvider: async () => {
    const response = await fetch("/api/hermes-live/socket", {
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Live Voice is unavailable");
    return (await response.json()).url;
  },
});

const audio = new HermesLiveAudio(client, {
  workletUrl: "/assets/hermes-live/mic-worklet.js",
});

client.subscribe(renderSnapshot);
client.on("transcript.delta", renderTranscript);
client.on("run.event", renderTaskEvent);
client.on("approval.request", renderApproval);
client.on("audio.output", (message) => void audio.play(message).catch(renderError));
client.on("input.speech_started", () => audio.interrupt("provider detected user speech"));

await client.connect();
```

The host endpoint should return either:

1. a same-origin authenticated WebSocket proxy URL; or
2. a short-lived, single-purpose WebSocket URL issued by the host backend.

The gateway accepts a static bearer for trusted direct clients, but it does not mint per-user tickets. Do not ship `HERMES_LIVE_AUTH_TOKEN` in a public JavaScript bundle, local storage, or a long-lived browser URL. Copy the Hermes Dashboard integration's proxy pattern when building a production community integration.

### Required UI Event Mapping

A complete UI should handle at least:

| Contract | UI behavior |
| --- | --- |
| `session.ready` | Show provider, model, protocol, audio input/output, and turn-detection capabilities. |
| `transcript.delta` | Append speaker-attributed conversation text. |
| `audio.output` | Queue PCM playback through `HermesLiveAudio`. |
| `input.speech_started` | Stop local assistant playback and cancel/truncate provider output. |
| `response.started/completed/cancelled/failed` | Represent provider speech lifecycle separately from Hermes work. |
| `run.started/event/completed/failed/stopping/stopped` | Show task progress, keep stop controls pending through `stopping`, and render sanitized final output only at a terminal event. |
| `approval.request/responded` | Render explicit choices and lock the decision while it is submitted. |
| `session.error`, client `error`, and `close` | Show actionable connection state without leaking internal credentials or upstream error details. |

Speech interruption and Hermes task cancellation are different actions:

- `audio.interrupt(...)` clears queued local playback and sends correlated provider cancellation/truncation.
- `client.cancelResponse(...)` sends only the protocol cancellation request; a custom audio player must clear its own queue.
- `client.stopRun(...)` requests a stop for the active Hermes run while leaving the voice session connected. Keep the UI in `stopping` until `run.stopped`, `run.completed`, or `run.failed` confirms a terminal state.

Do not map both actions to one ambiguous stop button.

### Approval UX

Treat approvals as high-consequence controls:

- show the command/description and inspectable pattern supplied by Hermes;
- offer only the `choices` in the structured approval envelope;
- show permanent approval only when `allowPermanent` is true and `patternKey` or `patternKeys` is present;
- require a second confirmation before submitting `always`;
- preserve the emitted FIFO order and make only the oldest pending approval actionable;
- remove only the exact `runId` + `approvalId` acknowledged by `approval.responded` (protocol v2 always confirms `resolved: 1`);
- disable duplicate decisions while a response is in flight;
- keep the approval attached to the active run shown in the UI.

Submit the exact gateway-owned identity; do not derive it from the upstream event:

```js
client.respondToApproval(choice, request.runId, {
  approvalId: request.approval.approvalId,
});
```

### Audio And Browser Requirements

- Microphone capture requires `localhost` or another secure context.
- Copy `hermes-live-voice/browser/mic-worklet.js` into a same-origin static asset path.
- Start `AudioContext` and microphone capture from a user gesture.
- Respect `session.ready.realtime.audio`; mock mode and some future providers may disable input or output.
- Bound queued playback and clear it immediately on interruption or disconnect.
- Await `client.disconnect()`. A clean resolution means the gateway confirmed session cleanup; rejection or `session_shutdown_unconfirmed` means the user must verify any active task in Hermes.
- Test keyboard focus, screen-reader labels, reduced motion, narrow layouts, and permission denial.

## Community UI Compatibility

### Hermes WebUI

The community [Hermes WebUI](https://github.com/nesquena/hermes-webui) is the most natural next adapter because it already has a dedicated extension system and turn-based voice UI. A secure Live Voice integration should be a separate panel using the shared browser client plus a small backend WebSocket proxy. A frontend-only extension would expose the shared gateway token and is not a production design.

The existing microphone flow should remain available. Hermes Live is a persistent realtime provider/Hermes session with its own interruption and task lifecycle, so silently presenting it as an ordinary chat turn would make history and cancellation behavior confusing.

### Open WebUI

[Open WebUI can connect to Hermes Agent](https://github.com/open-webui/docs/blob/main/docs/getting-started/quick-start/connect-an-agent/hermes-agent.mdx) through Hermes' OpenAI-compatible API. That provides ordinary text chat and Open WebUI's existing turn-based voice experience around Hermes.

It does not currently implement the Hermes Live protocol. OpenAI-compatible Chat Completions alone do not provide this project's persistent provider socket, PCM audio stream, barge-in/truncation, Hermes run events, or approval envelope. An Open WebUI integration therefore needs an explicit realtime extension point and authenticated server-side relay; do not advertise it as plug-and-play today.

### Hermes Desktop And Native Apps

Hermes Desktop has its own native turn-based voice loop and does not load Dashboard plugins. A future integration can reuse the JSON/WebSocket contract but needs a native audio transport and UI. Native mobile and device clients are similarly protocol-ready, not already implemented.

## Terminal

For local microphone use, run Hermes and press Ctrl+B. For a remote/headless gateway session:

```sh
HERMES_LIVE_URL=https://voice.example.com \
HERMES_LIVE_AUTH_TOKEN=your-gateway-token \
hermes-live terminal
```

The terminal shows transcript, provider response state, Hermes task progress, approvals, and separate `/interrupt` and `/stop` commands. It intentionally has no native microphone/audio dependency stack.

## Integration Verification

Before calling a UI integration ready:

1. Verify authenticated status and WebSocket connection without exposing a bearer in browser state or logs.
2. Confirm protocol v2 and render the provider/model/audio capabilities from `session.ready`.
3. Send text and complete a real Hermes run.
4. Test microphone permission granted and denied.
5. Verify provider audio playback and barge-in.
6. Start a long Hermes tool run, stop it, and confirm the voice session remains connected.
7. Exercise allow, deny, and permanent approval confirmation with an inspectable pattern.
8. Disconnect/reconnect and navigate away during an active run.
9. Test desktop, narrow mobile, keyboard-only, reduced-motion, and screen-reader behavior.
10. Inspect browser, Dashboard, gateway, and Hermes logs for errors and credential disclosure.

The provider-specific manual checklist remains in [Live Provider Testing](live-provider-testing.md).
