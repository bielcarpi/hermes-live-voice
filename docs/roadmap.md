# Roadmap

Hermes Live Voice has one product goal: keep a natural realtime conversation responsive while Hermes Agent performs supervised work in the background.

The project is a self-hosted voice control plane, not a replacement for Hermes, a generic agent framework, a telephony platform, or a claim of affiliation with Marvel.

## v0.5 Beta: Durable Voice Supervisor

The `0.5.0-beta.1` gate is the protocol v3 architecture:

- immediate stable task receipts while conversation continues;
- server-owned tasks that outlive client/provider disconnects;
- private atomic local-file persistence and reconnect snapshots;
- owner-scoped list, exact get/result, exact stop, and notification acknowledgement;
- bounded exclusive execution plus disjoint read-only parallelism;
- internal Hermes SSE plus periodic status reconciliation;
- gateway-restart recovery while the same Hermes process remains alive;
- explicit `unknown` and ambiguous-dispatch fencing instead of unsafe retries;
- durable completion notifications, with OpenAI out-of-band speech and Gemini best-effort speech;
- aligned Dashboard, browser SDK/demo, terminal, Docker, and plugin surfaces;
- fail-closed deny-all plus stop for approval-requiring tasks.

Beta exit requires real Hermes, real provider, Docker, reconnect, gateway-restart, exact-stop, package-install, and release-pipeline evidence—not only unit tests.

## Next: Make The Supervisor Operationally Complete

- A safe authenticated operator workflow for inspecting/resolving fenced `dispatch_unknown` state without hand-editing JSON.
- Richer allowlisted progress stages without exposing reasoning, raw tool arguments, paths, or secrets.
- Explicit telemetry hooks for task queue time, run time, recovery, interruption, errors, provider usage, and cost.
- Provider reconnection: Gemini context-window compression, session resumption, and `GoAway` migration.
- Optional OpenAI spoken-input transcription with explicit model and cost configuration.
- Signed short-lived client identity, per-owner quotas, and a deployment model suitable for more than one trusted user.
- A documented upstream compatibility matrix and stable Dashboard backend-auth contract.
- A maintained Hermes WebUI adapter with an authenticated server-side relay.
- Cross-browser/device accessibility and long-session evidence.

Interactive approvals remain out until Hermes Live can prove one response targets exactly one upstream approval under concurrent controllers. UI polish is not a substitute for that identity contract.

## Later: Demand-Proven Scale

- Pluggable durable stores and leader/lease semantics for multi-node gateway failover.
- Per-user/provider budgets and policy controls.
- WebRTC/Opus through an established media stack when real remote/mobile deployments need it.
- Additional realtime providers through the existing adapter port.
- A separately maintained local speech adapter if offline demand is demonstrated.
- Full-duplex terminal audio only if it adds value beyond official Hermes Voice Mode without burdening the core package.

Hermes Agent restart durability requires upstream support for persisted/recoverable execution. Hermes Live should not simulate that guarantee by replaying ambiguous mutations.

## Provider Admission Gate

A provider/model is supported only after:

1. a real session connects and confirms close;
2. negotiated speech input/output works;
3. all four background-task tool calls and responses work;
4. conversation continues during a task;
5. completion notification behavior is characterized honestly;
6. barge-in/cancellation/truncation behaves correctly;
7. provider errors and redirects do not leak credentials;
8. captured fixtures cover the documented event shapes.

Current sources of truth are [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime) and the [Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api). Future model names stay out until they are public and pass this gate.

## Adoption Signals

Scope expands when there is evidence of:

- independent installations completing a real background task;
- repeat use, not one-time demos;
- users continuing a conversation while multiple tasks run;
- clients built outside this repository;
- setup completed in under ten minutes;
- real preference for this persistent voice supervisor over ordinary turn-based voice;
- concrete demand for multi-user auth, multi-node recovery, or additional transports.

Share a focused deployment shape and evidence through a [feature request](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=feature_request.md) or GitHub Discussion.
