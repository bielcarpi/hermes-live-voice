---
name: Provider compatibility report
about: Share a live-provider smoke result without exposing private data
title: "[provider] "
labels: documentation
assignees: ""
---

## Summary

- Hermes Live Voice version or commit:
- Hermes Agent version or commit:
- Provider: local / Gemini / OpenAI
- Provider model:
- Voice:
- Region or deployment, if relevant:
- Client surface: Dashboard / browser SDK / terminal / Docker
- Result: passed / failed / blocked

## Commands

Paste only redacted command output.

```sh
hermes-live print-config
hermes-live doctor --provider-smoke
hermes-live launch-check
```

## Behavior Checked

- [ ] Provider session opened and reached ready state.
- [ ] Audio input was accepted in the configured format.
- [ ] Audio output played through the selected client surface.
- [ ] Barge-in or local interruption stopped stale output.
- [ ] At least one direct conversational turn completed.
- [ ] At least one Hermes task was delegated through `/v1/runs`.
- [ ] Task status/progress reached the client without raw Hermes credentials.
- [ ] Completion notification was delivered or retained for reconnect.
- [ ] Exact task stop affected only the selected task.
- [ ] Provider close/reconnect behavior was recorded honestly.

## Evidence

Do not paste API keys, bearer tokens, private audio, full transcripts, prompts,
task results, local usernames, customer paths, or sensitive Hermes output.

```txt
provider ready:
first turn:
task receipt:
task completion:
interrupt or stop:
reconnect:
```

## Failure Or Blocker

If this failed or was blocked, describe the smallest actionable cause.

```txt
failure class:
operator action needed:
upstream provider issue:
Hermes issue:
follow-up issue or PR:
```
