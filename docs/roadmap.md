# Roadmap

Hermes Live Voice has one job: keep conversation responsive while Hermes does supervised work in the background.

The current release covers the local, single-gateway case: durable task receipts, bounded scheduling, reconnect recovery, exact task controls, and completion notifications across the Dashboard, browser client, and terminal.

## Next

- Better provider reconnection, including Gemini session resumption, context compression, and `GoAway` migration.
- Useful progress updates that never expose reasoning, raw tool arguments, paths, or secrets.
- Metrics for queue time, run time, recovery, interruptions, provider usage, and errors.
- Short-lived client identity, per-owner limits, and a documented multi-user deployment pattern.
- A maintained Hermes WebUI adapter with a server-side authenticated relay.
- More cross-browser, mobile, accessibility, and long-session testing.

## Later, If Users Need It

- Pluggable task stores and leader/lease semantics for multi-node failover.
- Per-user provider budgets and policy controls.
- WebRTC or Opus through an established media stack for remote and mobile deployments.
- More realtime providers through the existing adapter boundary.
- A separately maintained local speech adapter when offline demand is clear.

## Boundaries

Interactive approvals remain out until one response can be proven to target exactly one upstream Hermes approval. Hermes Agent restart recovery also needs upstream persisted execution; the gateway will not replay an ambiguous mutation to imitate durability.

This project does not aim to replace Hermes, become a general agent framework, or carry a custom media stack without a concrete use case.

If one of these items matters to your deployment, open a focused [feature request](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=feature_request.md) or start a [Discussion](https://github.com/bielcarpi/hermes-live-voice/discussions) with the client, topology, and success criteria.
