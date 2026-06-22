# Changelog

## 0.1.0

- Initial public gateway shape.
- Add Gemini Live, OpenAI Realtime, and mock live providers.
- Add Hermes run/event/approval/stop bridge.
- Add browser demo, docs, examples, and optional plugin metadata.
- Protect readiness/capabilities behind gateway auth when configured.
- Restrict query-token auth to browser WebSocket upgrades.
- Add `HERMES_LIVE_DEMO_ENABLED=false` to disable the built-in browser demo, with production defaults closed.
- Validate base64 audio frames and PCM16 byte alignment before provider forwarding.
- Keep internal Hermes session keys server-side.
- Add OpenAI push-to-talk/VAD turn detection configuration.
- Add best-effort realtime provider response cancellation for interruption handling.
- Require `GOOGLE_CLOUD_PROJECT` for Gemini Enterprise mode before startup.
- Default Gemini Live to `gemini-3.1-flash-live-preview`.
- Bound stalled Hermes JSON requests with `HERMES_LIVE_HERMES_TIMEOUT_MS` while keeping established run event streams open.
- Restrict gateway JSON endpoints to `GET`/`HEAD` and return `405` for unsupported methods.
- Reconstruct completed Hermes output from streamed message deltas when the terminal event omits output.
- Stop active Hermes runs before aborting run event streams on client disconnect.
- Add live-provider testing guide, Docker healthcheck, CI Docker build, web demo syntax checks, and package smoke checks.
- Add `hermes-live client "..."` for terminal smoke tests against a running gateway.
- Add a built gateway smoke test against a fake Hermes API Server.
- Verify the packed npm tarball installs, exposes the CLI, and imports correctly.
- Require Hermes run/event/stop/approval support before `/ready` reports ready.
- Add a provider-ready timeout so live sessions fail visibly instead of hanging before `session.ready`.
- Close OpenAI Realtime sockets when initial session setup is rejected.
- Fail session startup immediately when a provider errors or closes before readiness.
- Add `HERMES_LIVE_MAX_TEXT_CHARS` to bound client text input and provider tool-call messages.
- Scope run stop, status, and approval actions to the active Hermes run for the current voice session.
- Require gateway auth for network-accessible binds unless explicitly opted out, and only send Hermes session-key headers on authenticated Hermes requests.
- Bound raw client WebSocket payload size from configured audio/text limits before JSON parsing.
