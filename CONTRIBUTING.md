# Contributing

Thanks for helping make Hermes voice-first.

## Local Setup

```sh
npm install
npm run verify
```

`npm run verify` includes TypeScript checks, web demo syntax checks, plugin syntax checks, unit tests, build, CLI/gateway smokes, and package install smoke.

Use `HERMES_LIVE_PROVIDER=mock` with `HERMES_AGENT_API_SERVER_KEY` set for local gateway work unless you are testing a live provider contract.

## Pull Requests

- Keep provider-specific logic inside `src/adapters/outbound/realtime`.
- Keep Hermes API assumptions inside `src/adapters/outbound/hermes`.
- Keep session orchestration and tool-call policy inside `src/application/live-gateway`.
- Do not expose Hermes credentials or realtime provider credentials to clients.
- Add or update tests for protocol, provider normalization, run lifecycle, and security-sensitive paths.
- Document user-visible protocol changes in `docs/client-protocol.md`.

## Live Provider Tests

Default CI does not use real Gemini or OpenAI credentials. If a change touches a live provider adapter, include either:

- a unit test around normalized provider events, or
- `npm run check:live-provider` output from a manual live credential test.

## Dependency Updates

Patch and minor updates should keep `npm audit --audit-level=moderate` and `npm run verify` green. Major updates to `@google/genai`, `zod`, `typescript`, or `vitest` should be handled as explicit compatibility work because this gateway depends on provider SDK event shapes and TypeScript build behavior.
