# Security

## Supported Versions

Security fixes target the latest released minor version.

## Reporting

Please do not open public issues for vulnerabilities. Use the repository's [private vulnerability reporting](https://github.com/bielcarpi/hermes-live-voice/security/advisories/new) so reports, reproduction details, and fixes stay private until coordinated disclosure.

If private reporting is unavailable, contact the maintainer through the GitHub profile without including vulnerability details in public comments.

## Scope

Security-sensitive areas include:

- Gateway authentication and origin checks.
- Handling of Hermes and provider API keys.
- Session key generation.
- Approval forwarding.
- Run stop/cancellation behavior.
- Static file serving.
- Provider tool-call parsing.

## Baseline Deployment Guidance

- Set `HERMES_LIVE_AUTH_TOKEN` to a high-entropy value outside local development.
- Set `HERMES_LIVE_ALLOW_ORIGIN` to the exact app origin in browser deployments.
- Leave `HERMES_LIVE_DEMO_ENABLED=false` in public production deployments unless the demo is intentionally exposed.
- Keep `HERMES_BASE_URL` private to the gateway network.
- Do not put Gemini/OpenAI/Hermes credentials in mobile apps or browser code.
- Terminate TLS before exposing the gateway beyond localhost.
- Run the Docker image as the bundled non-root `node` user.
- Put rate limits in front of public deployments.
- Keep `HERMES_LIVE_TRUST_CLIENT_IDENTITY=false` unless every client is trusted to choose a Hermes memory scope.
- Keep `HERMES_LIVE_RUN_EVENT_DETAIL=summary` or `none` for non-developer clients.
- Set `HERMES_LIVE_MAX_SESSIONS` to a provider- and budget-appropriate ceiling.

## Out of scope

- Vulnerabilities in Hermes Agent, Gemini, OpenAI, Node.js, or an upstream dependency that are not caused by this repository.
- Reports that require exposing a gateway with the documented unsafe unauthenticated opt-out.
- Social engineering, denial-of-service traffic generation, or testing against deployments you do not own.
- Provider availability, quota, pricing, or model-quality reports.
