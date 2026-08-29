# Roadmap And Contributor Ideas

These are scoped improvements that would make Hermes Live Voice easier to adopt. Each item is narrow enough to become a GitHub issue when someone is ready to own it.
Copy-ready first issues are in [Community Issue Drafts](community-issue-drafts.md).

For the path toward an official Hermes integration, see the
[upstream integration RFC](upstream-integration-rfc.md). The short version:
keep provider SDKs and audio lifecycle in this companion repo, align with
Hermes' realtime/session and Runs API contracts, and only use official wording
after maintainer acceptance.

## Static Dashboard Screenshots

**Problem:** New users can read the architecture, but they cannot immediately see the Live Voice Dashboard flow.

**Scope:**

- Capture one clean Dashboard Live Voice screenshot with a connected session.
- Capture one task inbox screenshot with a completed retained result.
- Add both images to `assets/`.
- Reference them from the README without adding a video or recording.

**Acceptance criteria:**

- The screenshots contain no secrets, local usernames, customer paths, task output, or API keys.
- The README first screen shows what users will see after setup.
- `npm run check:docs` passes.

## Linux Managed Local Voice Setup

**Problem:** The managed local provider path is Apple Silicon-first. Linux users must run the upstream local voice service manually.

**Scope:**

- Add a Linux service manager for the local Hugging Face speech-to-speech provider.
- Detect supported GPU/CPU profile and fail with actionable diagnostics when unsupported.
- Keep provider credentials and model paths out of logs.

**Acceptance criteria:**

- `hermes-live setup --provider local --service` works on a documented Linux profile.
- `hermes-live local status` and `hermes-live local logs` work on Linux.
- Unsupported systems get a clear fallback to `HERMES_LIVE_LOCAL_URL`.

## Interactive Approval Support

**Problem:** Protocol v6 fails approval-required Hermes work closed because the gateway cannot safely target an exact upstream approval request.

**Scope:**

- Track the Hermes approval identity contract required for safe UI approval.
- Add protocol messages for approval request, response, timeout, and cancellation only after exact targeting is available.
- Add Dashboard and terminal UX for approval controls.

**Acceptance criteria:**

- No approval button appears unless the gateway can prove exact upstream targeting.
- Browser clients never receive Hermes API credentials or raw upstream approval envelopes.
- Approval tests cover stale, duplicated, ambiguous, and cancelled approval requests.

## Minimal React Integration Example

**Problem:** The browser SDK is documented, but frontend users still need a copyable app pattern.

**Scope:**

- Add `examples/react-live-voice/` with a minimal client.
- Use a same-origin ticket endpoint or documented WebSocket URL provider.
- Show task notification handling and playback interruption.

**Acceptance criteria:**

- The example does not embed the gateway bearer token in browser code.
- It handles `task.notification`, response interruption, close, and reconnect.
- It has a short README and a smoke check.

## Provider Compatibility Receipts

**Problem:** CI proves protocol and adapter behavior, but live provider access can drift.

**Scope:**

- Add a documentation template for live provider smoke receipts.
- Record provider, model, date, region when relevant, and exact checked behavior.
- Keep secrets, transcripts, and audio out of the receipt.

**Acceptance criteria:**

- The release checklist links to the receipt template.
- Receipts distinguish local, Gemini Live, and OpenAI Realtime.
- Failed or blocked live checks are recorded as blocked, not passing.

Template: [Provider Compatibility Receipt Template](provider-compatibility-receipt-template.md).

## Docker Production Readiness Example

**Problem:** The Docker Compose example is useful, but operators need a concise production checklist.

**Scope:**

- Add a production deployment note for TLS, origins, auth token, rate limits, task file persistence, and non-loopback binds.
- Include a reverse-proxy health check flow.

**Acceptance criteria:**

- The docs tell operators exactly which endpoints can be public and which must stay private.
- The example keeps Hermes itself private.
- `npm run check:docs` passes.
