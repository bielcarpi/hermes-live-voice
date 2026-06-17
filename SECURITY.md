# Security

## Supported Versions

Security fixes target the latest released minor version.

## Reporting

Please do not open public issues for vulnerabilities. Email the maintainers or use GitHub private vulnerability reporting if enabled.

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

- Set `HERMES_LIVE_AUTH_TOKEN` outside local development.
- Set `HERMES_LIVE_ALLOW_ORIGIN` to the exact app origin in browser deployments.
- Keep `HERMES_BASE_URL` private to the gateway network.
- Do not put Gemini/OpenAI/Hermes credentials in mobile apps or browser code.
- Terminate TLS before exposing the gateway beyond localhost.
- Put rate limits in front of public deployments.
