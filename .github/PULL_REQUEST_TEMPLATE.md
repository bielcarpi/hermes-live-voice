## Why

Describe the concrete user or integration problem.

## What changed

Keep this focused. Call out protocol, provider, security, plugin, or deployment behavior explicitly.

## Verification

- [ ] `npm run verify`
- [ ] `npm audit --audit-level=moderate`
- [ ] Tests added or updated
- [ ] Docs and changelog updated when user-visible
- [ ] No secrets, private audio, prompts, or sensitive Hermes output included
- [ ] No unrelated generated or vendored code

## Live provider evidence

If the Gemini or OpenAI adapter changed, list the provider, exact model, command, and result. Otherwise write “Not applicable.”

## Security and compatibility

Explain any effect on credentials, client identity, Hermes memory scope, run events, approvals, session limits, or public protocol compatibility.
