# Roadmap

Hermes Live Voice has one purpose: talk to Hermes while background work continues.

## Current priorities

- Make the recommended setup lead directly to a successful Dashboard conversation.
- Qualify continuous input, acoustic interruption, spoken completion, reconnect, and full result retrieval with a real provider and Hermes worker.
- Record a short real workflow demo and test setup with first-time users.
- Keep the Dashboard focused on conversation and tasks; put technical controls in diagnostics.

Use the [provider compatibility receipt](provider-compatibility-receipt-template.md) to document live evidence and blockers. Deterministic tests alone do not establish audio quality or account/model access.

## Later

Managed Linux local voice and interactive approvals remain secondary to the everyday flow. Approvals require a stable upstream identity contract before they can be exposed safely. Additional providers and client features need a demonstrated user need.

## Scope

The project stays a self-hosted Hermes Dashboard integration with a shared browser SDK and advanced text terminal. It does not add a second Dashboard, hosted accounts/billing, multi-node task infrastructure, or automatic retries of ambiguous work.

Open a focused [feature request](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=feature_request.md) before starting a large change.
