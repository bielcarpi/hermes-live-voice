# Provider Compatibility Receipt Template

Use this template when a release changes a realtime provider handshake, default
model, session configuration, audio format, tool-call mapping, cancellation, or
notification behavior.

Do not attach audio, full transcripts, API keys, bearer tokens, prompts, task
results, local usernames, customer paths, or private Hermes output.

## Summary

- Date:
- Hermes Live Voice version or commit:
- Hermes Agent version or commit:
- Provider:
- Provider model:
- Voice:
- Region or deployment, if relevant:
- Client surface: Dashboard / browser SDK / terminal / Docker
- Result: passed / failed / blocked

## Environment

```txt
Node:
Operating system:
Install method:
Hermes API mode:
Gateway bind:
TLS or tunnel:
```

## Commands

```sh
hermes-live print-config
hermes-live doctor --provider-smoke
hermes-live launch-check
```

For a source checkout:

```sh
npm run verify
npm run check:live-provider
```

## Behavior Checked

- Provider session opened and reached ready state.
- Audio input was accepted in the configured format.
- Audio output played through the selected client surface.
- Barge-in or local interruption stopped stale output.
- At least one direct conversational turn completed.
- At least one Hermes task was delegated through `/v1/runs`.
- Task status/progress reached the client without raw Hermes credentials.
- Completion notification was delivered or retained for reconnect.
- Exact task stop affected only the selected task.
- Provider close/reconnect behavior was recorded honestly.

## Evidence

Paste only redacted, bounded evidence.

```txt
provider ready:
first turn:
task receipt:
task completion:
interrupt or stop:
reconnect:
```

## Failures Or Blockers

If the check failed or was blocked, record the exact class of failure without
marking the provider as passing.

```txt
failure class:
operator action needed:
upstream provider issue:
Hermes issue:
follow-up issue or PR:
```

## Public Claim Allowed

Choose one.

- Passing: This provider path has current live evidence for this release.
- Blocked: This provider path is implemented but live evidence is blocked.
- Failing: This provider path must not be advertised as currently working.
