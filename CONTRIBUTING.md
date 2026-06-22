# Contributing

Thanks for helping make Hermes voice-first.

## Local Setup

```sh
npm install
npm run verify
```

`npm run verify` includes TypeScript checks, web demo syntax checks, plugin syntax checks, unit tests, build, CLI/gateway smokes, and package install smoke.

Use `HERMES_LIVE_PROVIDER=mock` for local gateway work unless you are testing a live provider contract.

## Pull Requests

- Keep provider-specific logic inside `src/gemini` or `src/openai`.
- Keep Hermes API assumptions inside `src/hermes`.
- Do not expose Hermes credentials or realtime provider credentials to clients.
- Add or update tests for protocol, provider normalization, run lifecycle, and security-sensitive paths.
- Document user-visible protocol changes in `docs/client-protocol.md`.

## Live Provider Tests

Default CI does not use real Gemini or OpenAI credentials. If a change touches a live provider adapter, include either:

- a unit test around normalized provider events, or
- notes from a manual live credential test.
