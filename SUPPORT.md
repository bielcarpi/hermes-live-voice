# Support

Hermes Live Voice is community maintained.

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
hermes-live --version
hermes-live doctor
```

`doctor` reports config presence and paths but never credential values. Review the output again before publishing it.

For provider problems, also run `hermes-live doctor --provider-smoke`. This opens a real provider session but does not send audio or start a Hermes run.

From a source checkout, run `npm run verify` and replace `hermes-live` with `node dist/cli.js` in the diagnostics above.

Hermes Agent, Gemini, and OpenAI have their own support channels for upstream behavior outside this gateway.
