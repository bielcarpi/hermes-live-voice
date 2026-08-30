# Roadmap

Hermes Live Voice keeps one narrow purpose: realtime voice for Hermes conversations and background work.

## Priorities

### Managed Local Voice On Linux

The managed local provider currently targets Apple Silicon. Linux users must run the Hugging Face realtime server separately.

A Linux implementation must provide service lifecycle commands, hardware checks, private defaults, and clear diagnostics for unsupported systems.

### Interactive Approvals

Protocol v6 denies approval-required work because the gateway cannot target one exact Hermes approval request safely.

Approval controls can ship after Hermes exposes a stable identity contract for each request. Tests must cover stale, duplicate, cancelled, and ambiguous approvals.

### Provider Compatibility Evidence

Provider APIs and model access can change after deterministic tests pass. Release-relevant provider changes need a current live receipt or a documented blocker.

Use the [provider compatibility receipt template](provider-compatibility-receipt-template.md) when you provide evidence.

## Non-Goals

- A standalone web demo or a second dashboard outside Hermes Dashboard.
- A hosted multi-tenant voice service, account system, or billing product.
- Provider audio pipelines inside the Hermes Agent process.
- Automatic retry of work when the gateway cannot prove whether Hermes accepted a mutating request.

Open a focused [feature request](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=feature_request.md) before you start a large change.
