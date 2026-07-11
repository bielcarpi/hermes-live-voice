# Support

Hermes Live Voice is a community-maintained developer preview.

## Where to ask

- Use [GitHub Discussions](https://github.com/bielcarpi/hermes-live-voice/discussions) for setup questions, client ideas, provider compatibility, and deployment patterns.
- Use a [bug report](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=bug_report.md) for a reproducible defect in this repository.
- Use a [feature request](https://github.com/bielcarpi/hermes-live-voice/issues/new?template=feature_request.md) for a focused product improvement backed by a use case.
- Use [private vulnerability reporting](https://github.com/bielcarpi/hermes-live-voice/security/advisories/new) for security issues.

Do not paste API keys, auth tokens, private audio, Hermes session identifiers, prompts, tool arguments, or sensitive logs into public issues.

## Before opening a bug

Run:

```sh
node --version
npm run verify
node dist/cli.js print-config
node dist/cli.js check
```

`print-config` redacts configured secrets. Review the output again before publishing it.

For provider problems, also run `node dist/cli.js provider-smoke` with the same environment. This opens a real provider session but does not send audio or start a Hermes run.

Hermes Agent, Gemini, and OpenAI have their own support channels for upstream behavior outside this gateway.
