## Why

Describe the concrete user or integration problem.

## What changed

Keep this focused. Call out protocol, provider, security, plugin, or deployment behavior explicitly.

## Verification

- [ ] `npm run verify`
- [ ] `npm audit --audit-level=moderate`
- [ ] Tests added or updated
- [ ] Docs and changelog updated when user-visible
- [ ] Package, plugin, and Dashboard versions stay aligned when release metadata changes
- [ ] Public positioning still passes `npm run check:positioning`
- [ ] Maintainer-facing release evidence still passes `npm run check:maintainer-readiness` when relevant
- [ ] GitHub Actions workflow changes pass `actionlint`
- [ ] External GitHub Actions stay pinned to full commit SHAs with `npm run check:workflow-pins`
- [ ] No secrets, private audio, prompts, or sensitive Hermes output included
- [ ] No unrelated generated or vendored code

## Live provider evidence

If a realtime provider adapter changed, list the provider, exact model or local runtime, command, and result. Otherwise write “Not applicable.”

## Security and compatibility

Explain any effect on credentials, client identity, Hermes memory scope, run events, approvals, session limits, or public protocol compatibility.
