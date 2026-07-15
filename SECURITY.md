# Security Policy

## Supported Versions

Security fixes target the latest released minor version. Prereleases receive fixes while they are the active preview channel, but operators should not treat a beta as a production support commitment.

## Reporting A Vulnerability

Do not open a public issue or discussion. Use GitHub's [private vulnerability reporting](https://github.com/bielcarpi/hermes-live-voice/security/advisories/new) and include:

- affected version and deployment shape;
- a minimal reproduction;
- expected and observed behavior;
- impact and any evidence of exploitation;
- whether Hermes, a provider, the gateway, a client, or the task state file is involved.

If private reporting is unavailable, contact the maintainer through the GitHub profile without posting vulnerability details publicly. Please allow time for coordinated investigation and disclosure.

## Security-Relevant Scope

Reports are especially useful when they involve:

- gateway authentication, browser origin policy, or the Dashboard relay;
- Hermes, provider, or gateway credential exposure;
- owner-scope bypass for task list, result, stop, or notification controls;
- durable task-store confidentiality, integrity, permissions, symlink handling, or recovery;
- duplicate/incorrect execution after ambiguous dispatch or restart;
- exact task-stop correlation;
- fail-closed approval denial and containment;
- provider tool-call validation, prompt/result injection boundaries, or secret reflection;
- static file serving, audio/payload limits, or redirect handling.

## Deployment Baseline

- Set a high-entropy `HERMES_LIVE_AUTH_TOKEN` for every non-loopback bind.
- Set an exact `HERMES_LIVE_ALLOW_ORIGIN` for browser clients.
- Keep Hermes and provider credentials server-side and Hermes API Server private.
- Use TLS, edge rate limiting, and an authenticated same-origin relay for public browser deployments.
- Keep `HERMES_LIVE_TRUST_CLIENT_IDENTITY=false` unless every client is trusted.
- Store `HERMES_LIVE_TASK_STATE_FILE` in a private persistent directory; persist `/var/lib/hermes-live` in Docker.
- Run the container as its bundled non-root user with the read-only filesystem and dropped capabilities from the Compose example.
- Disable the public demo unless it is intentionally deployed.
- Treat `unknown` task outcomes as potentially partially executed; audit before retrying.

The full threat model and operator guidance are in [docs/security.md](docs/security.md) and [docs/background-tasks.md](docs/background-tasks.md).

## Out Of Scope

- Upstream Hermes Agent, Gemini, OpenAI, Node.js, or dependency vulnerabilities not caused or amplified by this repository.
- Reports that require the documented unsafe unauthenticated opt-out on an exposed network.
- Provider availability, quota, pricing, model quality, or ordinary latency.
- Social engineering, destructive denial-of-service traffic, or testing systems you do not own or lack permission to assess.
