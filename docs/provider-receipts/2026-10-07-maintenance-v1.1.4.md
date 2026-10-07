# Maintenance v1.1.4 validation

Date: 2026-10-07. Provider SDK: `@google/genai` 2.27.0.
Environment: macOS, Node 24.19.0, source checkout. Live result: **blocked**.

## Scope

This release updates dependencies, development tooling, and CI permissions.
It does not change provider defaults, audio formats, gateway tools, or the
public protocol. Zod 3 schema and error compatibility still uses `zod/v3`.

The Gemini adapter fixtures exercise session configuration, audio and text
input, normalized provider events, tool results, interruption, error handling,
and closure. The complete deterministic suite contains 749 tests. Packed
consumer checks cover Zod 3 and Zod 4 installations.

## Live limits

No Gemini or OpenAI credential and no managed Hermes Live configuration were
available in this environment. A credentialed Gemini handshake and fresh audio
session could not be performed. Deterministic checks do not establish current
account access, microphone capture, audio playback, or real model behavior.

Before a wider rollout, run `hermes-live doctor --provider-smoke` and
`hermes-live launch-check` in the configured deployment. Complete the audio,
interruption, delegation, completion, and reconnect checks in
[live provider testing](../live-provider-testing.md). Record the actual Hermes,
provider, model, OS, and package versions in the receipt.
