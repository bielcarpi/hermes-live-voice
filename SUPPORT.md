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
hermes-live diagnostics
```

The diagnostics command writes a private, redacted JSON file. It excludes logs, prompts, task results, audio, and secret values. Review the file before attaching it to a public issue.

For provider problems, use `hermes-live diagnostics --provider-smoke`. This opens a real provider session but does not send audio or start a Hermes run.

From a source checkout, run `npm run verify` and replace `hermes-live` with `node dist/cli.js` in the commands above.

Hermes Agent, Gemini, and OpenAI have their own support channels for upstream behavior outside this gateway.
