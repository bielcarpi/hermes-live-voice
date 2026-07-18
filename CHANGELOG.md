# Changelog

## Unreleased

## 0.6.0 - 2026-07-18

- Add `hermes-live setup` as the normal installation path. It securely reuses Hermes's existing API Server key when available, prompts without echoing missing provider credentials, writes an allowlisted private config, installs and enables the matching plugin, verifies Hermes capabilities and a real Gemini/OpenAI session, and waits for the gateway to become ready.
- Add a native user-service lifecycle through launchd on macOS and systemd on Linux. `hermes-live service install|uninstall|start|stop|restart|status|logs` keeps the gateway available without a dedicated terminal, while service definitions contain only the managed-config path and never API keys.
- Add `hermes-live doctor` with human and JSON output for Node compatibility, config integrity, plugin/runtime version parity, Hermes CLI and durable-run capabilities, provider configuration and optional live session, service state, and gateway readiness. Every failed check includes an exact remediation.
- Store managed settings under `~/.hermes/hermes-live/config.env` with private permissions, atomic writes, process-environment precedence, an explicit key allowlist, and strict rejection of symlinks, unsafe permissions, duplicate/unexpected settings, oversized input, and non-string values. Project `.env` files are never loaded or executed.
- Make setup the primary README, plugin, Dashboard, and support path. The Dashboard now turns missing configuration, offline services, and failed readiness into the corresponding setup, service, and doctor commands.
- Verify the complete activation path from a clean packed npm install: Hermes key import, managed config permissions, exact plugin version, gateway startup, real readiness response, and redacted doctor output. Protocol v3 and the durable background-task contract are unchanged.

## 0.5.0 - 2026-07-16

- Keep the realtime conversation open while Hermes works. Delegated work is now owned by a durable server-side supervisor, survives client detachment, and reports retained results through an unread completion inbox after reconnect.
- Persist a task before accepting it, reconcile known Hermes runs after a gateway restart, and fence ambiguous dispatches as `dispatch_unknown` instead of retrying a mutation that Hermes may already have accepted. In-progress work still cannot survive a Hermes Agent restart.
- Run work exclusively by default. Operators can opt into parallel read-only tasks with disjoint resource keys only when they explicitly trust model-declared scopes through `HERMES_LIVE_TRUST_DECLARED_READ_ONLY=true`.
- Add exact background-task controls to the realtime tools, terminal, Dashboard, browser client, and wire protocol v3. Speech interruption and task cancellation remain separate operations.
- Harden the local task store with a private atomic file, strict single-writer lock, bounded retention, startup reconciliation, task-store readiness checks, offline containment and abandoned-lock recovery commands, and bounded shutdown. The stable state format reads beta state but becomes forward-only after writing new recovery fields.
- Deliver completion speech through bounded, retryable session claims and mark notifications spoken only after provider handoff. OpenAI isolates each task notice from conversation history, keeps a newly finished notice behind the user's current VAD turn, and targets interruption to the exact notice response; Gemini notices remain best effort.
- Remove the provisional `queuePosition` hint from protocol v3 because the bounded scheduler is not a strict FIFO queue. The field was optional in beta clients, but beta gateways and clients should still be upgraded together before reconnecting to stable v0.5.
- Keep approvals fail-closed until Hermes exposes identity that can target one exact request safely. Unknown or confirmed-missing runs can be contained without fabricating a result.
- Add a real built-image Docker smoke, pin the Hermes v0.18.2 fixture to its published image digest and revision, update `@google/genai` to 2.12.0, and verify the packed CLI, plugin, Dashboard, browser client, task recovery, and provider adapters.
- Export the new `tasks.trustDeclaredReadOnly`, task-store `health()`, readiness `tasks`, and `input_speech_stopped` contracts. Simplify the README, Dashboard, demo, and release docs around the project's actual role: real-time voice for Hermes Agent.

## 0.5.0-beta.1 - 2026-07-15

- Replace session-bound delegation with a server-owned durable task supervisor: tasks are persisted before acceptance, retain bounded results, survive client detachment, and reconcile after a gateway restart when Hermes still knows the upstream run.
- Keep the realtime conversation responsive while Hermes works, expose a durable unread completion inbox, restore every retained active/unread task even beyond the recent-history window, atomically claim spoken notices across concurrent sessions, and deliver bounded completion alerts without injecting task output into an unrelated provider turn.
- Add safe bounded concurrency: mutating and unspecified work runs exclusively, while explicitly `parallel_read_only` work overlaps only when its declared resource keys are disjoint.
- Introduce exact task control through `start_background_task`, `list_background_tasks`, `get_background_task`, and `stop_background_task`; provider interruption and task cancellation remain independent.
- Move the breaking wire contract to protocol v3, replace public `run.*` lifecycle messages with owner-scoped `task.*` snapshots/events/notifications, add per-task sequences and exact notification acknowledgements, and reject older clients clearly.
- Make ambiguous run dispatch fail closed as `dispatch_unknown` without automatic retry, reconcile Hermes run state through SSE plus bounded polling, and surface unprovable post-restart outcomes as `unknown` rather than guessing.
- Remove interactive approval controls from the truthful v0.5 surface. Current Hermes approvals are denied and the exact task is stopped fail-closed until upstream provides safely targetable approval identity.
- Upgrade the Dashboard, bundled browser demo, dependency-free browser SDK, and terminal around the same durable task inbox; add reconnect recovery, exact result/stop controls, and detach-without-cancel semantics.
- Add `/tasks`, `/status <taskId>`, `/result <taskId>`, `/stop <taskId>`, and `/interrupt` to the terminal, and make the one-shot client wait for the exact accepted task rather than an unrelated provider response.
- Isolate OpenAI completion notices from the active conversation, add authenticated best-effort Gemini realtime notices, and harden task/result content as untrusted input at the provider boundary.
- Persist state in a private atomic file, add retention and queue/concurrency bounds, run Docker non-root/read-only/capability-free with a dedicated state volume, and keep upstream run IDs, credentials, and approval authority out of the public protocol.
- Exercise the release candidate against the official Hermes Agent v0.18.2 Docker image for real run/SSE/stop behavior, exclusive serialization, reconnect restoration, retained results, and completion reporting, and require deterministic protocol, supervisor, client, plugin, terminal, gateway, package, security, and Docker gates before tagged publication.

## 0.4.0 - 2026-07-15

- Handle Gemini Live `toolCallCancellation` as an explicit exported provider event, correlate every cancellation to the bounded tool-call ledger, stop owned active runs, suppress queued and not-yet-sent results, and fail closed when Hermes side effects or provider delivery become indeterminate.
- Add a separate 120-second Hermes run-event SSE idle watchdog that is refreshed by upstream events and keepalive bytes while preserving the existing 30-second initial-response deadline.
- Remove upstream approval IDs from summary-mode run events; authenticated clients continue to receive only the gateway-owned approval identity used for decisions.
- Reject redirects and suppress untrusted error bodies on credentialed Hermes JSON/SSE calls; require credential-free, protocol-scoped Hermes/OpenAI endpoints; redact provider URL path/query text and provider-controlled error/close text from logs and diagnostics; prevent second-attempt OpenAI WebSocket authentication; pin Gemini/Vertex to validated official Google endpoints despite ambient SDK overrides; exact-pin the credentialed realtime transport dependencies; and harden the Hermes status tool and Dashboard bridge against unsafe origins and tokens, HTTP/WebSocket redirects, environment proxies, oversized/non-JSON responses, reflected credentials, untrusted fields, and inconsistent readiness claims.
- Correct the comparison with current Hermes Voice Mode and Desktop voice surfaces, document the synchronous delegation and provider-data boundaries, clarify community UI and terminal roles, avoid browser-playback warnings in text-only sessions, and make installed CLI diagnostics the primary support path.
- Slim the npm artifact by excluding contributor-only scripts, add a static package-renderable architecture diagram, and remove the obsolete completed migration plan and speculative model watchlist.
- Re-verify the packed CLI/plugin, Dashboard proxy, mock and real Hermes runs, and a real Gemini Live connection against the official Hermes Agent v0.18.2 image.

## 0.3.2 - 2026-07-15

- Publish `hermes-live-voice` on npm and make the installed `hermes-live` CLI the primary setup path for the gateway, Hermes plugin, terminal, and custom browser clients.
- Serialize tagged releases, protect immutable version tags/assets, select explicit npm dist-tags, make GitHub release creation retry-safe, and verify the exact npm tarball, provenance, dist-tag, and installed CLI after trusted publication.
- Streamline the README around a Dashboard-first quick start, clearer client choices, and concise production-readiness evidence.
- Update the runtime WebSocket dependency to `ws` 8.21.1 and move the development toolchain to TypeScript 7.0.2 and tsx 4.23.1, with an explicit TypeScript build root.
- Upgrade the GitHub Actions setup and artifact actions, make checksum manifests portable, group compatible Dependabot updates, and preserve the intentional Node 20 runtime baseline.
- Harden contribution guidance, checkout credential handling, and ignored secret, build, and editor artifacts for safer community contributions.

## 0.3.1 - 2026-07-14

- Negotiate targeted Hermes approval responses explicitly. Any current uncorrelated approval triggers deny-all where possible, run stop, fatal session closure, and an operator-verification warning; interactive choices require stable upstream IDs and exact run/approval/choice/count confirmation.
- Require exact Hermes stop confirmation instead of accepting missing, running, unknown, wrong-run, or conflicting-alias responses, and contain uncertain mutations.
- Make browser microphone stop/dispose independent of stalled permission, audio-context resume, and cleanup promises; keep disconnect responsive, preserve fatal UI errors, clear terminal approval cards, and improve push-to-talk/accessibility copy.
- Confirm Gemini/OpenAI provider closure, bound provider connection attempts, suppress and close late Gemini handshakes, and make provider smoke success require the upstream close event.
- Separate read-only package verification from release write/OIDC credentials, publish the already-verified tarball artifact, harden the Docker build/context and Compose runtime, and reject unbounded Hermes request timeouts.

## 0.3.0 - 2026-07-13

- Add a first-class **Live Voice** integration for Hermes Dashboard with responsive desktop/mobile layouts, browser microphone and playback, text fallback, transcript, capability status, task activity, separate response interruption and Hermes run cancellation, and approval controls.
- Add an authenticated same-origin Dashboard HTTP/WebSocket proxy that delegates to Hermes' own Dashboard authentication and origin checks while keeping the upstream gateway URL and bearer out of browser code.
- Publish a dependency-free `hermes-live-voice/browser` client and microphone worklet with strict protocol/lifecycle validation, bounded input and playback queues, request IDs, state subscriptions, and host-provided authenticated WebSocket URLs.
- Normalize client close frames to browser-legal codes and bounded UTF-8 reasons, recover from missing close events, suppress late audio after interruption until the next response begins, and replace stale connected notices when a gateway connection drops.
- Reserve browser playback capacity before awaiting autoplay permission, time-bound suspended-context resume, expose a user-gesture `primePlayback()` API, and make audio disposal independent of a stalled playback chain.
- Clear stale demo approvals on fatal disconnects and run npm trusted publishing on an explicitly verified Node 24/npm 11 OIDC runtime.
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
