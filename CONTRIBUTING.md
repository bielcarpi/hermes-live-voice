# Contributing

Thanks for helping make Hermes Agent feel like a live conversation.

Hermes Live Voice deliberately stays small: a Hermes plugin, a realtime gateway, provider adapters, and a client protocol. Focused changes are much easier to review, test, and ship than broad platform rewrites.

## Start with the use case

Before opening a large pull request, open a feature request or GitHub Discussion that explains:

- who is using the feature;
- the client and deployment shape;
- why Hermes Voice Mode is not sufficient;
- which provider or protocol behavior is required;
- how success will be demonstrated.

Small fixes and documentation corrections can go directly to a pull request.

## Prerequisites

- Node.js 20 or newer and the bundled npm CLI.
- Python 3 for the Hermes and Dashboard plugin smoke tests run by `npm run verify`.
- Docker only when changing the image or Compose example.
- A Hermes API server and provider credentials only for manual integration tests; mock mode and default CI do not need them.

## Fork and local setup

Fork the repository on GitHub, then clone your fork and keep the upstream repository as a separate remote:

```sh
git clone https://github.com/YOUR-USER/hermes-live-voice.git
cd hermes-live-voice
git remote add upstream https://github.com/bielcarpi/hermes-live-voice.git
git switch -c fix/short-description
npm ci
npm run verify
```

`npm run verify` covers TypeScript, web-demo syntax, plugin syntax, unit tests, build output, CLI/gateway smokes, fake Hermes HTTP/SSE integration, and packed-package installation.

Use `HERMES_LIVE_PROVIDER=mock` for deterministic gateway work. Real provider credentials are never required by default CI.

Before opening a pull request, bring your branch up to date with `upstream/main`, push it to your fork, and use the pull-request checklist below. Maintainers may edit a branch only when you leave GitHub's **Allow edits from maintainers** option enabled.

For plugin or Dashboard changes, test the plugin from your checkout instead of installing the tagged GitHub copy:

```sh
npm run build
node dist/cli.js plugin install --symlink
hermes plugins enable hermes-live
node dist/cli.js plugin status
```

See [docs/plugin.md](docs/plugin.md) for the local gateway and Dashboard workflow.

## Architecture boundaries

- Provider-specific behavior belongs in `src/adapters/outbound/realtime`.
- Hermes API assumptions belong in `src/adapters/outbound/hermes`.
- Session orchestration and tool-call policy belong in `src/application/live-gateway`.
- Public protocol schemas belong in `src/domain/protocol`.
- The realtime provider receives gateway tools, not the full Hermes toolset.
- Provider credentials, Hermes credentials, and Hermes session keys stay server-side.

Read [docs/architecture.md](docs/architecture.md) before changing those boundaries.

## Pull request scope

A good pull request does one coherent thing. Please do not combine a focused feature with:

- a project rebrand;
- unrelated web redesigns;
- a replacement backend or speech framework;
- generated or vendored dependency source;
- broad formatting changes;
- diagnostic scripts unrelated to the shipped path.

Do not vendor a speech server, model runtime, SDK, or other large upstream project into this repository. Integrate external runtimes through a documented adapter and keep their licensing and update lifecycle separate.

## Tests and evidence

Update tests for every user-visible or security-sensitive change. Relevant areas include:

- client protocol validation;
- provider event normalization;
- audio conversion;
- Hermes run, approval, and cancellation lifecycle;
- identity and event-detail policy;
- auth, origins, payload bounds, and session limits;
- CLI, plugin, package, and Docker behavior.

If a change touches Gemini Live or OpenAI Realtime, include normalized event fixtures and report one of:

- a successful `npm run check:live-provider`; or
- why a credentialed test was not possible and which deterministic fixtures cover the change.

Never include credentials, session tokens, private prompts, user audio, or sensitive Hermes tool output in fixtures or pull-request logs.

## Public API and documentation

- Document protocol changes in [docs/client-protocol.md](docs/client-protocol.md).
- Document configuration changes in `.env.example` and [docs/local-setup.md](docs/local-setup.md).
- Add user-visible changes under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
- Do not claim model support until the compatibility gates in [docs/roadmap.md](docs/roadmap.md) pass.
- Keep marketing statements consistent with the developer-preview security boundary.

## Dependency updates

Patch and minor updates should keep `npm audit --audit-level=moderate` and `npm run verify` green.

Major updates to `@google/genai`, `zod`, TypeScript, Vitest, or a realtime model default are explicit compatibility work. Provider SDK and event-shape changes require fixtures and, when possible, a live handshake.

## Commit and pull-request checklist

- [ ] The change has one clear purpose.
- [ ] `npm run verify` passes.
- [ ] `npm audit --audit-level=moderate` passes.
- [ ] Tests cover the changed behavior.
- [ ] Public protocol/config changes are documented.
- [ ] `CHANGELOG.md` is updated when users are affected.
- [ ] No credentials or sensitive Hermes data are present.
- [ ] No unrelated generated or vendored code is included.
- [ ] Live-provider evidence is included when the provider contract changed.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
