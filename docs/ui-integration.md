# UI Integration

Hermes Live Voice is a gateway and protocol, not one fixed application. The bundled Hermes Dashboard tab is the recommended browser surface; `hermes-live-voice/browser` is the integration API for community/custom UIs; `hermes-live terminal` is the remote/headless text surface.

This documents compatibility with Hermes Agent and community projects, not endorsement by their maintainers.

## Surface Matrix

| Surface | Support | Purpose |
| --- | --- | --- |
| Hermes Dashboard + Live Voice plugin | First-class | New/resumed chats, browser audio/text, transcript, durable task inbox, follow-ups, reconnect, notifications, interruption, and exact stop. |
| Bundled browser client | Development tool | Local provider/audio/protocol troubleshooting. |
| `hermes-live-voice/browser` | First-class integration API | Vanilla, React, Vue, Svelte, Electron, or mobile-web clients. |
| `hermes-live terminal` | First-class text control | SSH/headless task supervision, retained results, interruption, and exact stop. |
| Hermes Voice Mode/Desktop voice | Official Hermes features | First-party local voice experiences; not replaced by this project. |
| Generic OpenAI-compatible chat UI | Hermes chat only | Does not implement protocol v4 realtime audio, durable tasks, or notifications. |

## Hermes Dashboard

Install the package, activate Live Voice, and start Dashboard:

```sh
npm install --global hermes-live-voice
hermes-live setup
hermes dashboard
```

Choose **Live Voice**. The plugin contributes:

- `dashboard/manifest.json` for the `/live-voice` tab;
- a responsive, theme-aware frontend using the shared browser SDK and worklet;
- authenticated `/status` and `/live` plugin routes;
- a sanitized `/conversations` route and saved-chat picker;
- a server-side WebSocket relay that applies the gateway bearer.

The browser never receives `HERMES_LIVE_AUTH_TOKEN`. The plugin backend revalidates Hermes Dashboard authentication and origin policy, rejects redirects, and keeps the upstream URL and credential out of status responses.

For a remote gateway, set in the Dashboard server process:

```sh
HERMES_LIVE_URL=https://voice.example.com
HERMES_LIVE_AUTH_TOKEN=your-high-entropy-gateway-token
```

See [Hermes Plugin](plugin.md) for installation and relay details.

## Custom Or Community Browser UI

Install and import the dependency-free client:

```sh
npm install hermes-live-voice
```

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
  conversation: { mode: "resume", sessionId: savedHermesSessionId },
});

const audio = new HermesLiveAudio(client, {
  workletUrl: "/assets/hermes-live/mic-worklet.js",
});

client.subscribe(({ connection, tasks, unreadNotifications }) => {
  renderConnection(connection);
  renderTaskInbox(tasks, unreadNotifications);
});

client.on("transcript.delta", renderTranscript);
client.on("task.notification", renderNotification);
client.on("audio.output", (message) => void audio.play(message).catch(renderError));
client.on("input.speech_started", () => audio.interrupt("provider detected user speech"));
client.on("error", renderError);

await audio.primePlayback(); // Call directly in the initiating click/tap handler.
await client.connect();
```

The host endpoint must return either a same-origin authenticated WebSocket relay URL or a short-lived single-purpose URL issued by the host backend. Hermes Live does not mint per-user tickets. Never put the installation bearer in a public bundle, browser storage, or a long-lived URL.

## Required UI Mapping

| Contract | UI behavior |
| --- | --- |
| `session.ready` | Show provider, model, protocol v4, audio formats/turn detection, and task limits. |
| `session.ready.conversation` | Show the selected persisted Hermes chat and retain its writable session id for reconnect. |
| `task.snapshot` | Reconcile the owner inbox after initial connect/reconnect and correlated list/get requests. |
| `task.accepted/started/progress/stopping` | Show durable state and queue/progress without claiming success. |
| `task.completed/failed/cancelled/unknown` | Render the exact terminal/indeterminate outcome; never convert `unknown` into failure or success. |
| `task.notification` | Show unread completion/attention state and an exact “Mark read” action. |
| `transcript.delta`, `audio.output` | Render speaker-attributed conversation and queue negotiated audio. |
| `input.speech_started`, response lifecycle | Stop local playback and represent provider speech independently from Hermes work. |
| `session.error`, SDK `error`, and `close` | Show bounded actionable connection state without leaking credentials or provider errors. |

Use the SDK task controls:

```js
client.listTasks({ limit: 50 });
client.getTask(taskId);
client.followUpTask(taskId, "Apply the fix, then rerun the checks.");
client.stopTask(taskId, "user stopped this task");
client.acknowledgeNotification(taskId, notificationId);
```

List/reconnect snapshots contain summaries but omit full retained output. Use `getTask(taskId)` for details. `followUpTask(...)` creates a distinct worker only after the selected task is terminal and exposes its parent/root lineage. Connected clients can also receive bounded output with `task.completed`. Reconnect hydration may arrive in multiple 100-task frames; every retained active task and unread notification is included even when older read history is truncated.

## Separate Speech And Task Controls

Speech interruption and task cancellation are different operations:

- `audio.interrupt(...)` clears queued local audio and sends correlated provider cancellation/truncation;
- `client.cancelResponse(...)` cancels only provider output; a custom audio player must clear its own queue;
- `client.stopTask(taskId, ...)` requests cancellation of one exact server-owned task;
- disconnect/route change closes the conversation but leaves tasks running.

Do not map speech and task cancellation to one ambiguous stop button. Keep a task in `stopping` until `completed`, `failed`, `cancelled`, or `unknown` proves the next state.

## Durable Inbox And Notifications

Treat the task inbox as the source of truth. The SDK keeps lifecycle and notification revisions separate: lifecycle state is ordered by task id and sequence, while notification state also retains the exact notification id and acknowledgement. A lifecycle update and notification may share one sequence and arrive in either order; both are applied. Exact repeats within either channel are idempotent, conflicting equal-sequence repeats fail closed, and one channel never suppresses the complementary projection from the other. On reconnect, the SDK clears stale cache state on the first frame, merges any additional bounded frames, and retains unread notifications until an exact acknowledgement succeeds or the gateway explicitly withdraws a superseded uncertainty notice.

Provider speech is supplementary:

- OpenAI can announce a generic result through a response-scoped out-of-band audio response;
- Gemini receives a gateway-authenticated realtime text marker and is best-effort;
- neither path replaces the durable UI notification or exact task result.

Do not auto-acknowledge merely because a provider may have spoken. Let the user or clear UI policy mark the exact notification read.

## Approval UX

There is no interactive approval UX in protocol v4. Do not render approval buttons, synthesize approval identity from progress/events, or call Hermes approval APIs from the browser.

When a task requires approval, the gateway attempts deny-all and stops the exact task fail-closed. Show the resulting non-actionable stopping/terminal state and explain that Hermes Live cannot approve it safely.

## Audio And Browser Requirements

- Microphone capture requires localhost or another secure context.
- Copy `hermes-live-voice/browser/mic-worklet.js` to a same-origin static path.
- Call `audio.primePlayback()` synchronously from a user gesture before awaiting network work; start microphone capture from a gesture too.
- Respect `session.ready.realtime.audio`; mock mode disables audio.
- Browser audio currently expects PCM16 and rejects G.711 output.
- Bound playback while waiting for autoplay permission and clear it on interruption/disconnect.
- Test permission denial, keyboard focus, screen readers, reduced motion, and narrow layouts.

## Community UI Compatibility

### Hermes WebUI

The community [Hermes WebUI](https://github.com/nesquena/hermes-webui) is a natural adapter candidate because it already has voice input and administrator-controlled extension injection. A production integration should add a separate protocol-v4 panel and a backend WebSocket relay. A frontend-only extension would expose the shared bearer.

Keep Hermes WebUI's existing microphone flow available. Hermes Live is a persistent realtime conversation plus a durable task inbox; presenting it as an ordinary chat turn would hide reconnect and cancellation semantics.

### Open WebUI

[Open WebUI can connect to Hermes Agent](https://github.com/open-webui/docs/blob/main/docs/getting-started/quick-start/connect-an-agent/hermes-agent.mdx) through Hermes' OpenAI-compatible API for ordinary chat and turn-based voice.

It does not currently implement Hermes Live protocol v4. An integration needs an explicit realtime extension and authenticated server-side relay; do not advertise it as plug-and-play.

### Hermes Desktop And Native Apps

Hermes Desktop has its own voice surface and does not automatically consume Dashboard tabs. A future native integration can reuse the JSON task contract but needs platform-specific audio transport, credential relay, background lifecycle, and UI work. “Protocol-ready” is not “already integrated.”

## Terminal

For a remote/headless gateway:

```sh
HERMES_LIVE_URL=https://voice.example.com \
HERMES_LIVE_AUTH_TOKEN=your-gateway-token \
hermes-live terminal
```

The terminal renders transcript, provider response state, task snapshots/lifecycle, notifications, and retained results. `/ack <taskId>` (or `/read`) acknowledges the exact current unread notification; `/interrupt` stops speech; `/stop <taskId>` stops one task; `/quit` detaches. It is an interactive control/diagnostic surface, not deterministic automation, and it can incur realtime-provider usage.

Use `hermes-live terminal --resume <sessionId>` to continue a saved Hermes chat, the default `hermes-live terminal` to create a new one, or `--unbound` for legacy provider-only conversation. `/followup <taskId> <message>` starts durable follow-up work.

## Integration Verification

Before calling a UI ready:

1. Confirm protocol v4 and negotiated provider/audio/task capabilities.
2. Verify the browser never receives the shared bearer or Hermes/provider credentials.
3. Create a new Hermes chat, reconnect to it by id, and verify canonical turns remain in its persisted history.
4. Send text, receive an immediate task receipt, inspect sanitized live activity, and keep conversing while the task runs.
5. Start a follow-up from a terminal task and verify its parent/root lineage and separate worker id.
6. With `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true`, start independent read-only work and verify only disjoint resource keys overlap. With the default setting, verify work stays exclusive.
7. Stop one exact task while another continues.
8. Disconnect/reconnect during work and reconcile from `task.snapshot` without duplicates.
9. Verify completion/failed/cancelled/unknown notifications and exact acknowledgement.
10. Restart only the gateway while Hermes stays alive and verify task recovery.
11. Verify an approval-requiring task is denied/stopped with no approval controls.
12. Test microphone permission, playback, barge-in, mobile layout, keyboard, reduced motion, and screen readers.
13. Inspect browser, relay, gateway, and Hermes logs for errors and credential disclosure.

Continue with [Live Provider Testing](live-provider-testing.md) for real provider evidence.
