# Changelog

## Unreleased

## 0.3.0 - 2026-07-13

- Add a first-class **Live Voice** integration for Hermes Dashboard with responsive desktop/mobile layouts, browser microphone and playback, text fallback, transcript, capability status, task activity, separate response interruption and Hermes run cancellation, and approval controls.
- Add an authenticated same-origin Dashboard HTTP/WebSocket proxy that delegates to Hermes' own Dashboard authentication and origin checks while keeping the upstream gateway URL and bearer out of browser code.
- Publish a dependency-free `hermes-live-voice/browser` client and microphone worklet with strict protocol/lifecycle validation, bounded input and playback queues, request IDs, state subscriptions, and host-provided authenticated WebSocket URLs.
- Normalize client close frames to browser-legal codes and bounded UTF-8 reasons, recover from missing close events, suppress late audio after interruption until the next response begins, and replace stale connected notices when a gateway connection drops.
- Move the negotiated wire contract to protocol v2, a breaking client handshake that removes raw provider envelopes, adds `run.stopping`, and requires exact approval identity and choice correlation while retaining `/v1/live` as the endpoint path.
- Enable Gemini Live input/output audio transcription, preserve speaker/final metadata, avoid duplicate transcript events, and emit a normalized response-start lifecycle before assistant output.
- Preserve concurrent approvals in a capacity-bounded FIFO across the browser client, Dashboard, demo, persistent terminal, and one-shot CLI; only the queue head is actionable and only the exact confirmed entry is removed.
- Assign gateway-owned approval IDs, correlate them to bounded upstream identities, cache exact responses idempotently, and reject request-ID reuse, duplicate upstream identities, mismatched run/approval IDs, widened choices, and bulk resolution.
- Project approval details without silently rewriting them: opaque or incomplete requests are deny-only, `once` requires informed display context, and session/permanent choices require exact inspectable permission patterns plus a second interactive confirmation.
- Remove approval submission from realtime-provider tools and contain indeterminate approval or run mutations by stopping owned work and closing the session instead of risking a retry against the wrong action.
- Emit `run.stopping` when Hermes accepts a stop request and reserve `run.stopped` for confirmed `run.cancelled`; completion and failure retain their own terminal messages.
- Harden the default unauthenticated loopback WebSocket policy against Host-header and DNS-rebinding attacks while retaining headerless terminal/native clients and exact configured browser origins.
- Bound client/provider queues, WebSocket backpressure, PCM16 conversion, transcripts, audio, usage, tool arguments/results, Hermes JSON/SSE bodies, and terminal output; close on violated provider contracts instead of allowing unbounded memory growth.
- Correlate Hermes run IDs across start responses, status, SSE events, approvals, and terminal events; treat ambiguous starts, early event-stream EOF, late starts, failed stops, and unconfirmed disconnect cleanup as fatal containment conditions.
- Bound provider input, tool-result, response-cancel, and close operations so a stalled realtime provider cannot make session shutdown wait forever.
- Add `hermes-live terminal` and its `chat` alias for persistent remote/headless text control with transcripts, task progress, approvals, `/interrupt`, `/stop`, and safe exit behavior.
- Package the Dashboard frontend/backend assets and browser client in plugin, npm tarball, and Docker runtime outputs, with generated-asset parity and smoke checks.
- Make the Hermes Dashboard integration the recommended UI, add the persistent terminal as a first-class headless surface, document the secure browser SDK/relay path for community UIs, clarify Hermes Voice Mode and generic OpenAI-compatible UI boundaries, and add a real Dashboard screenshot.
- Align the Docker Compose OpenAI Realtime default with `gpt-realtime-2.1`.
- Make tagged release jobs fail when the Git tag does not match `package.json` or point at the exact protected `main` commit.

## 0.2.1 - 2026-07-13

- Replace session-label regex trimming with a linear sanitizer to prevent adversarial input from causing excessive processing.
- Keep unexpected internal HTTP failure details in server logs while returning a generic error response to clients.
- Add regression coverage for long hostile session labels and internal error-detail disclosure.
- Document and verify native Hermes plugin installation directly from the repository subdirectory.

## 0.2.0 - 2026-07-12

- Reposition the project as the realtime custom-client bridge for Hermes Agent, with a marketing-first README, honest Voice Mode comparison, provider compatibility roadmap, support guide, and release runbook.
- Default OpenAI Realtime sessions to the currently documented `gpt-realtime-2.1` model.
- Add a documented `gpt-live-1` compatibility watchlist without claiming current API availability.
- Make Hermes memory identity server-owned by default; client-selected `profileId` and `userLabel` now require `HERMES_LIVE_TRUST_CLIENT_IDENTITY=true`.
- Default Hermes run events to an allowlisted summary, with explicit `summary`, `none`, and trusted-development `raw` policies.
- Add a configurable concurrent WebSocket limit through `HERMES_LIVE_MAX_SESSIONS`.
- Serialize client message handling and sanitize Hermes run failures returned to clients and realtime providers.
- Ask realtime models to acknowledge meaningful work briefly before starting a Hermes run.
- Add CODEOWNERS, a pull-request template, issue routing, support documentation, CodeQL, dependency review, and a Node 20/22/24 CI matrix.
- Prepare optional npm trusted publishing behind the `PUBLISH_NPM=true` repository variable.
- Align the Hermes plugin manifest with package version `0.2.0`, add explicit standalone-plugin metadata, and verify version parity in the release gate.
- Pin GitHub Actions to current immutable release commits and replace the deprecated dependency-license denylist with an explicit non-copyleft allowlist.
- Rename the documented Hermes credential env to `HERMES_AGENT_API_SERVER_KEY` while keeping `HERMES_API_KEY` as a legacy alias.
- Remove unsupported OpenAI Realtime reasoning effort value `none` and tighten clone-first setup docs.
- Add `hermes-live provider-smoke` and `npm run check:live-provider` for optional real Gemini Live/OpenAI Realtime session handshakes.
- Upgrade the Gemini SDK to v2, Vitest to v4, and tsx to the latest v4 release while keeping Node type-checking aligned with the package's minimum supported Node 20 runtime.
- Treat client-close aborts of active Hermes event streams as expected cancellation instead of logging or emitting a false run failure.
- Normalize structured realtime-provider startup errors into safe, actionable diagnostics instead of displaying `[object Object]`.

## 0.1.0

- Initial public gateway shape.
- Add Gemini Live, OpenAI Realtime, and mock live providers.
- Add Hermes run/event/approval/stop bridge.
- Add browser demo, docs, examples, and Hermes plugin metadata.
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
- Fail the terminal client when the gateway closes before completing a one-shot request.
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
- Flush the web demo microphone worklet before sending `audio.end`.
- Keep the web demo in a starting/error state until `session.ready` succeeds.
- Include Hermes plugin syntax validation in `npm run verify`.
- Register the Hermes plugin's `hermes_live_status` tool and `/hermes-live` slash command.
- Add `hermes-live plugin install/status/path` so npm installs can place the Hermes plugin under `~/.hermes/plugins`.
- Move the TypeScript gateway into a ports-and-adapters layout with domain protocol/audio helpers, application ports, inbound HTTP/WebSocket adapters, and outbound Hermes/realtime adapters.
- Run the Docker image as the non-root `node` user.
- Add defensive security headers to JSON and browser demo responses.
- Close idle and active HTTP connections during explicit server shutdown.
- Bound client protocol metadata fields before dispatch.
- Only send OpenAI Realtime reasoning-only session fields to reasoning-capable models.
- Let the terminal client complete on direct realtime provider transcript responses.
- Fail the terminal client clearly when a direct realtime response has no text output.
- Emit normalized provider transcript/audio/tool events before raw provider envelopes.
- Send Gemini text turns through `sendClientContent`.
- Normalize Gemini Live top-level audio data messages and require tool-call IDs for Gemini tool responses.
- Require `HERMES_API_KEY` before serving so Hermes auth failures fail fast.
- Require stronger gateway auth tokens for network-accessible binds.
- Enforce gateway exposure checks in the exported server API, not only the CLI.
- Fail fast on missing Hermes or realtime provider credentials when the exported server API creates default clients.
- Document `HERMES_LIVE_MAX_AUDIO_BYTES` in the example environment and compose files.
- Document every public server event in the client protocol guide.
- Render streamed Hermes run deltas clearly in the web demo.
- Send OpenAI truncation metadata for queued assistant audio even when the user has heard `0` ms.
- Forward OpenAI VAD speech-start events as `input.speech_started` and make the web demo stop/truncate queued playback.
- Cancel provider output on web-demo speech-start even when no truncation metadata is available yet.
- Echo client message IDs as `requestId` on related `session.error` responses.
- Fail direct provider adapter connects with clear credential/configuration errors.
- Make `hermes-live check` report actionable gateway, Hermes, and realtime configuration failures.
- Align `/ready` with the same actionable readiness report used by the CLI.
- Disclose that realtime readiness does not open a provider session handshake.
- Send the derived Hermes session key on authenticated run status, stop, and approval calls.
- Send the derived Hermes session key on authenticated run event streams.
- Reject realtime provider tool calls without call IDs before starting Hermes work.
- Send Gemini Live text turns through realtime input before falling back to client-content history updates.
- Rename the public package and repository positioning to `hermes-live-voice` while keeping the `hermes-live` CLI and Hermes plugin id stable.
