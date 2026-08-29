# Provider Compatibility Receipt - Local Environment Blocked

Result: blocked.

This receipt records a live-provider verification attempt from a source checkout.
It is not a passing provider receipt.
The attempt happened before the current v1.0.2 release-candidate metadata was
prepared, so version references below describe that historical local
environment.

## Summary

- Date: 2026-08-29.
- Hermes Live Voice version or commit: v1.0.1 source checkout, based on
  `5dfa495`, with local uncommitted readiness changes.
- Hermes Agent version or commit: not verified.
- Provider requested by active environment: Gemini.
- Provider model: `gemini-3.1-flash-live-preview`.
- Client surface: CLI doctor and launch-check preparation path.
- Result: blocked.

## Environment

```txt
Node: v24.19.0
Operating system: macOS source checkout
Install method: local repository checkout
Hermes API mode: not reachable from active process
Gateway bind: loopback
TLS or tunnel: none
```

## Commands

```sh
node dist/cli.js print-config
node dist/cli.js doctor
node dist/cli.js doctor --config ~/.hermes/profiles/hlv-v09-audit/hermes-live/config.env --json
```

## Behavior Checked

- Provider session opened and reached ready state: not checked.
- Audio input was accepted in the configured format: not checked.
- Audio output played through the selected client surface: not checked.
- Barge-in or local interruption stopped stale output: not checked.
- At least one direct conversational turn completed: not checked.
- At least one Hermes task was delegated through `/v1/runs`: not checked.
- Task status/progress reached the client without raw Hermes credentials: not checked.
- Completion notification was delivered or retained for reconnect: not checked.
- Exact task stop affected only the selected task: not checked.
- Provider close/reconnect behavior was recorded honestly: blocked before session open.

## Evidence

Redacted evidence:

```txt
default config:
  provider: gemini
  model: gemini-3.1-flash-live-preview
  hermes base: loopback origin
  gateway bind: loopback

default doctor:
  node: pass
  managed config: warn, no managed config installed for active environment
  plugin: fail, installed plugin v0.8.0 while package is v1.0.1
  hermes cli: warn, hermes command not on PATH
  hermes api: fail, HERMES_AGENT_API_SERVER_KEY unavailable to active process
  voice provider: fail, Gemini key or enterprise config unavailable
  gateway service: fail, installed service not running
  live gateway: fail, fetch failed

profile-specific doctor:
  managed config: pass
  runtime settings: mock on loopback
  provider-config: pass for mock
  hermes api: fail, fetch failed
  gateway service: fail, installed service not running
  live gateway: fail, fetch failed
```

No API keys, bearer tokens, private prompts, audio, task results, customer paths,
or private Hermes output were recorded.

## Failure Or Blocker

```txt
failure class: local environment not configured for live provider verification
operator action needed: run setup for a real provider, install matching plugin, start Hermes gateway, then rerun launch-check
upstream provider issue: none proven
Hermes issue: none proven
follow-up issue or PR: none; this is an environment receipt
```

## Public Claim Allowed

Blocked: this checkout does not provide current live-provider evidence. Public
copy may say provider paths are implemented, but must not say Gemini, OpenAI, or
local voice are live-verified for this exact branch/release from this machine.
