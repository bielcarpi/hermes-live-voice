# Maintainer Readiness Audit

Status: current repository audit for maintainer review.

Checked on 2026-08-29 against local branch `docs/live-voice-positioning` and
the public repository `bielcarpi/hermes-live-voice`.

This document answers one question: can Hermes Live Voice be presented to the
Hermes ecosystem as an official-quality external integration candidate?

Short answer: yes for maintainer review, not yet as an official Hermes
integration. The repo has the right architecture, install path, safety posture,
and community packaging. It still needs current live-provider receipts and
upstream maintainer acceptance before stronger wording is truthful.

## Requirement Matrix

| Requirement | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Product boundary is clear. | Proven | README says Hermes is the brain, providers handle speech/turn-taking, and Hermes Live owns gateway/task supervision. Architecture docs keep the same boundary. | Keep this wording stable in outreach. |
| Not Saturday-specific. | Proven | No Saturday product copy, accounts, billing, onboarding, or hosted infrastructure are in the README or launch kit. | None. |
| Usable outside the app. | Proven | Public npm package, CLI, Dashboard plugin, browser SDK, Docker docs, and terminal client are documented. | Keep install command current after each release. |
| Plugin model is correct. | Proven | The Hermes plugin is small: status tool, slash command, Dashboard tab, same-origin proxy, v2 manifest metadata, optional environment declarations, and declared Dashboard runtime dependencies. The audio gateway runs as a companion process, and docs treat direct subdirectory install as a pinned review path while npm setup/upgrade manages the runtime. | Do not move provider sockets or audio runtime into Hermes plugin code. |
| Realtime API rationale is correct. | Proven from current provider docs | OpenAI documents server-side Realtime WebSocket usage and recommends WebRTC for direct browser/mobile clients. Its model guide names `gpt-realtime-2` plus `gpt-realtime-1.5` for current realtime model choices, while some transport examples still show a more specific reasoning-model string. Gemini Live documents stateful WSS, PCM audio, barge-in, and tool use. | Recheck before each release that changes provider defaults. |
| OpenAI Realtime path is plausible. | Proven structurally; live proof required for release claims | Code uses server-side WebSocket, `session.update`, input audio append, cancellation/truncation handling, and normalized event names. OpenAI docs support these primitives. | Run and record a live provider receipt for the release being promoted. |
| Gemini Live path is plausible. | Proven structurally; live proof required for release claims | Code uses `@google/genai` Live, function declarations, PCM normalization, and manual tool responses. Gemini docs confirm 16 kHz PCM input, 24 kHz PCM output, and synchronous Gemini 3.1 function calling. | Run and record a live provider receipt for the release being promoted. |
| Local voice path is honest. | Partial | README says managed local setup is Apple Silicon-first and needs 12 GB+ memory. Local runtime contract smoke passes. | Manual audio/device receipt is still needed before broad claims about real hardware quality. |
| Background task model is correct. | Proven locally; upstream contract still evolving | Gateway persists task receipts before accepting work, separates task stop from speech interruption, uses `/v1/runs`, and documents ambiguous dispatch as `unknown`. | Upstream idempotent run creation or exact recovery would remove the lost-create limitation. |
| Approval safety is correct. | Proven with current upstream limits | Protocol v6 has no approval UI/tool. Approval-required tasks fail closed until Hermes exposes exact request identity. | Implement approval UX only after upstream exact approval identity exists. |
| Credential boundary is safe. | Proven locally | Security docs require server-side Hermes/provider keys, same-origin Dashboard proxy, exact origin controls, TLS/rate limits for public binds, and private task state. Plugin README documents the egress boundary. | Re-run plugin guard and audit if plugin egress changes. |
| Public support path is safe. | Proven | SECURITY, SUPPORT, bug/feature/provider issue templates, diagnostics guidance, and provider receipt template all warn against leaking secrets, audio, prompts, paths, and task results. | Add labels later if maintainers want a dedicated provider-compatibility label. |
| Release quality is sufficient. | Proven for deterministic local checks | `npm run verify`, package smoke, docs check, npm audit, plugin smoke, and plugin guard pass on this branch. | Protected PR checks must pass after push. |
| Repository security health reporting is prepared. | Partial | CodeQL, dependency review, pinned GitHub Actions, workflow pin smoke, branch protection, npm trusted-publishing metadata, pinned actionlint CI, and a pinned OpenSSF Scorecard workflow are present. | Let the Scorecard workflow publish one public result before adding a README badge or claiming a score. |
| Required status checks cover all launch-critical CI lanes. | Partial | Current `main` protection requires Linux verify for Node 20/22/24, CodeQL for TypeScript/Python, and dependency review. | Add the existing `workflow-lint` and `verify-windows` CI jobs to required checks before the public v1.0.2 release. |
| Upstream Hermes version freshness is visible. | Proven for current image | The pinned deterministic compatibility fixture covers Hermes Agent 0.20.0. A forced-pull compatibility smoke also passed against the current `nousresearch/hermes-agent:latest` image, which reported Hermes Agent v0.20.6. | Refresh the pinned fixture when a new stable baseline is chosen. |
| Live-provider evidence is complete. | Not proven | The docs now include a receipt template and issue path. | Run credentialed OpenAI/Gemini/local checks before saying every provider is currently verified for the release. |
| Upstream fit is strong. | Partial | The upstream RFC maps this repo to the current Hermes realtime/session and Runs API discussions and avoids claiming official status. | Post evidence-focused comments only after maintainer-facing docs are merged. |
| Existing community realtime work is respected. | Proven locally | The upstream RFC and launch kit acknowledge `hermes-talk` as the stronger existing multi-provider session-contract proof, separate core-hosted, surface-hosted, and gateway-hosted topologies, and frame Hermes Live Voice as gateway-hosted consumer evidence. | Keep this boundary visible in Discord and upstream comments. |
| Upstream readiness is independently checkable. | Partial | `npm run audit:upstream-readiness` reads live Hermes upstream issues, the `hermes-talk` docs PR, plugin-index availability, public release state, and maintainer-acceptance signals. | It should fail until upstream acceptance or an accepted plugin-discovery path exists. |
| Discovery path is high-fit and legitimate. | Partial | The launch kit identifies current listing status, high-fit channels, and approved messaging without generic launch sites or broad cross-posting. | Actual adoption requires external users after approved outreach. |
| 100-star adoption path is explicit. | Partial | The launch kit now includes the current public baseline, measurable launch gates, expected star channels, a 48-hour operating plan, and anti-manipulation rules. | Execute only after the reviewed release, public metadata, and provider evidence gates are ready. |
| First-contributor path is prepared. | Proven locally | Community issue drafts give narrow, copy-ready issues for OpenAI, Gemini, local Apple Silicon, Dashboard screenshots, and Linux local-runtime research. | Open the issues only after the reviewed release URL and npm version are public. |
| Bare-name Hermes plugin discovery. | Partial | The launch kit includes a pinned `subdir` entry and a direct pinned install command. Current Hermes docs/code point at `NousResearch/hermes-plugin-index`, but that repository returned 404 when checked and is tracked upstream in NousResearch/hermes-agent#87565. | Submit to the canonical index after the reviewed commit is public, or use the maintainer-accepted temporary index until the canonical path exists. |

## Peer Patterns Applied

The 2026-08-29 peer check included broad realtime voice repos
`livekit/agents`, `pipecat-ai/pipecat`, `openai/openai-realtime-agents`, and
`streamcoreai/streamcore-server`; Hermes ecosystem directories such as
`0xNyk/awesome-hermes-agent`; and high-traction public Hermes plugins such as
`42-evey/hermes-plugins`, `Humalike/hermes-humalike-plugin`,
`8bit64k/cronalytics`, and `rarf/hermes-quota-plugin`, plus lower-traction
Dashboard voice/plugin examples. The strongest common patterns were immediate
install clarity, visual proof, explicit safety notes, concrete operational
commands, active contribution paths, and honest limitations.

The current repository now follows the strongest patterns seen in high-signal
Hermes plugin and realtime voice repos:

- one clear workflow before feature lists;
- a copyable first install path;
- a doctor or launch-check command;
- explicit operator actions instead of hidden setup magic;
- clear plugin/runtime boundary;
- current Hermes manifest metadata, declared dependencies, and environment-variable review surface;
- visible security policy and support policy;
- CodeQL, dependency review, pinned Actions, actionlint CI, branch protection, and prepared
  OpenSSF Scorecard reporting;
- issue templates and PR checklist;
- provider compatibility receipts for live API drift;
- copy-ready first issues for provider evidence and docs improvements;
- limitations documented as behavior;
- maintainer-facing upstream plan that does not ask for endorsement first.
- explicit coordination language for existing realtime voice work, especially
  `hermes-talk`, so the project adds gateway-hosted evidence instead of trying
  to displace another community plugin.
- a measurable 100-star adoption plan that focuses on Hermes-specific channels,
  directory discovery, provider receipts, first-contributor issues, and upstream
  evidence instead of broad launch-site traffic or artificial stars.

The one pattern deliberately not used is a demo recording. Static Dashboard
preview, transcript, launch-check, and provider receipts are the proof path for
this project.

## Official Presentation Boundary

Allowed wording before upstream acceptance:

```txt
Community MIT realtime voice gateway and Dashboard plugin for Hermes Agent.
```

Allowed maintainer-facing ask:

```txt
Would Hermes maintainers accept an external realtime voice gateway pattern in
the docs, with Hermes Live Voice listed as a community implementation?
```

Not allowed yet:

```txt
Official Hermes voice gateway.
Official NousResearch integration.
The recommended realtime voice plugin for Hermes.
Production ready for every provider.
```

Target wording after explicit maintainer acceptance:

```txt
Implements the documented external realtime voice gateway pattern for Hermes Agent.
```

Do not use stronger wording unless maintainers approve it in writing.

## Evidence Checked

Local verification commands run on this branch:

```sh
npm run verify
npm audit --audit-level=moderate
npm run check:docs
npm run check:plugin-index-entry
npm run check:workflow-pins
npm run check:positioning
npm run check:maintainer-readiness
git diff --check
npm pack --dry-run
docker build -t hermes-live-voice:readiness-1.0.2 .
node scripts/gateway-smoke.mjs --docker-image hermes-live-voice:readiness-1.0.2
actionlint
docker buildx imagetools inspect ghcr.io/bielcarpi/hermes-live-voice:1.0.1
gh attestation verify oci://ghcr.io/bielcarpi/hermes-live-voice:1.0.1 --repo bielcarpi/hermes-live-voice
python3 plugins/hermes-live/tests/test_manifest_contract.py
uvx --from hermes-plugin-guard hpg scan plugins/hermes-live --fail-on high --format text
```

Observed results:

- `npm run verify`: passed with 42 test files and 761 tests.
- `check:scripts`: included in `npm run verify` and syntax-checks every
  JavaScript maintenance script, including release and external audit helpers.
- `check:external-audits`: included in `npm run verify` and fixture-checks the
  public launch and upstream readiness scripts, including stale metadata,
  missing branch checks, absent maintainer acceptance, and accepted community
  listing states.
- `npm run check:hermes-compatibility`: passed against the pinned Hermes Agent
  v0.20.0 image.
- `HERMES_COMPATIBILITY_IMAGE=nousresearch/hermes-agent:latest
  HERMES_COMPATIBILITY_EXPECTED_VERSION='*' npm run check:hermes-compatibility`:
  passed after forcing a fresh image pull; the image reported Hermes Agent
  v0.20.6.
- `check:plugin-local`: included in `npm run verify` and passes the
  dependency-free plugin manifest contract test.
- Packed package smoke: passed with 279 files in the release-candidate tarball.
- `npm pack --dry-run`: passed for `hermes-live-voice-1.0.2.tgz` with 279 files.
- Docker build and Docker gateway runtime smoke: passed for
  `hermes-live-voice:readiness-1.0.2`.
- Public GHCR image path: `ghcr.io/bielcarpi/hermes-live-voice:1.0.1`
  resolves as an OCI index with Linux `amd64` and `arm64` manifests.
- Public GHCR provenance check: `gh attestation verify` passed for
  `ghcr.io/bielcarpi/hermes-live-voice:1.0.1`.
- GitHub package-settings API check: not proven because the active `gh` token
  lacks `read:packages`; the OCI registry path above is the verified public
  install surface.
- GitHub Actions workflow lint: passed with `actionlint`.
- CI workflow-lint job: prepared with pinned `rhysd/actionlint` v1.7.12 and
  SHA256 verification for the Linux amd64 release archive.
- Workflow pin smoke: passed and rejects mutable external GitHub Action refs in
  `.github/workflows`.
- Public launch audit: prepared as `npm run audit:public-launch`. It reads live
  GitHub and npm state after publication and intentionally fails until the
  reviewed release, launch topics, npm homepage, Issues, Discussions, and
  required branch-protection checks are public.
- Upstream readiness audit: prepared as `npm run audit:upstream-readiness`. It
  reads live Hermes upstream issues, the `hermes-talk` docs PR, plugin-index
  availability, public release state, and maintainer-acceptance signals. It is
  intentionally not part of `npm run verify`.
- `npm run audit:upstream-readiness -- --report-only`: ran successfully as a
  read-only report and correctly identified external blockers: public latest is
  still v1.0.1, canonical `NousResearch/hermes-plugin-index` is not reachable,
  temporary `Revell-ai/hermes-plugin-index` is reachable, #77111/#64947/#87565
  remain open, #97325 remains open for `hermes-talk`, and no explicit upstream
  maintainer acceptance signal was found in labels or maintainer/collaborator
  comments on the tracked threads.
- Branch protection check: `main` requires Linux verify, CodeQL, and dependency
  review. The existing `workflow-lint` and `verify-windows` CI jobs are not
  currently required and should be added before launch.
- `npm audit --audit-level=moderate`: 0 vulnerabilities.
- Markdown docs check: passed across 30 Markdown files.
- Plugin-index entry generator: passed and emits a pinned `subdir` entry for
  `plugins/hermes-live`.
- Direct pinned plugin install remains the reliable path until bare-name
  discovery is proven through the canonical or maintainer-accepted temporary
  index. Treat subdirectory installs as pinned review installs; use
  `hermes-live upgrade` for normal package-managed updates.
- Positioning smoke: passed and guards public copy against false official
  claims, Saturday-specific wording, and stale broad package keywords.
- Maintainer readiness smoke: passed and guards package counts, docs counts,
  version parity, and launch-boundary evidence.
- Plugin guard: passed with no high findings.
- Plugin guard remaining review item: one expected medium dynamic outbound
  egress finding for the plugin's configured companion gateway probe.
- Changed-file credential marker scan: passed with no matches for common API
  key, bearer token, GitHub token, cloud access key, or private-key patterns.
- OpenSSF Scorecard workflow: prepared with a pinned action and SARIF upload.
  Do not add a README badge until the public workflow publishes a result.
- OpenAI Realtime default: refreshed to `gpt-realtime-2`, matching the current
  OpenAI Realtime model guide. Some OpenAI transport examples still show a more
  specific reasoning-model string, so provider receipts should record the exact
  model accepted by the target account. `gpt-realtime-1.5` remains explicitly
  configurable for the faster non-reasoning path.
- `npm outdated --json`: only intentional major-track maintenance remains.
  `@types/node` stays on the Node 20 line because Node 20 is the minimum
  supported runtime. Zod 4 is a separate migration and not part of the v1.0.2
  release gate. The Gemini SDK is current on the same major line after updating
  `@google/genai` to 2.19.0.

Source-level review checked these boundaries:

- `LiveGatewaySession` owns provider session lifecycle and public protocol
  projection.
- `TaskSupervisor` owns persisted task admission, queueing, stop/status, and
  reconnect projection.
- `HermesClient` calls Hermes `/v1/runs`, `/v1/runs/{run_id}/events`, status,
  stop, approval response, and saved-session APIs through bounded credentialed
  HTTP/SSE requests.
- `GeminiLiveAdapter`, `OpenAIRealtimeAdapter`, and the local adapter remain
  outbound provider adapters instead of leaking provider policy into Hermes.
- The Dashboard plugin proxy applies gateway credentials server-side and
  enforces Hermes Dashboard authentication checks before relay.

Residual local test gaps to keep visible:

- Low-level HTTP server listen/close helpers are exercised through gateway
  smokes rather than direct unit tests.
- The local Hugging Face adapter close path has adapter-level coverage for
  idempotent close, the normal provider close frame, and the pipeline reuse
  grace window. The low-level private helper functions remain covered through
  the adapter contract rather than direct exports.
- Manual audio-device quality, perceived latency, and real provider speech
  quality still require live receipts.

Release-candidate state checked on 2026-08-29:

- Local release target: v1.0.2.
- Packed package smoke: passed with 279 files in the v1.0.2 tarball.
- npm did not yet contain `hermes-live-voice@1.0.2` at audit time, so the
  candidate version is available for the next immutable tag/release.

Public state checked on 2026-08-29:

- Repository is public.
- GitHub description matches the self-hosted realtime voice gateway positioning.
- GitHub topics are mostly aligned with Hermes, realtime voice, local AI,
  browser SDK, background tasks, and provider discovery. The current public
  topics still include older broad terms; apply the metadata refresh in
  [Community Sharing](launch-kit.md) before the next outreach push.
- Public npm latest is still v1.0.1. Its description is aligned, but its
  keywords still include older broad terms. The local v1.0.2 package metadata
  removes those terms and must be published before npm-focused outreach.
- Issues and Discussions are enabled.
- The repository has a custom social preview image. The local review asset is
  `assets/social-preview.png`, rendered at 1280x640 and under 1 MB for GitHub's
  repository settings.
- Latest release: v1.0.1.
- Latest public `main` CI run for v1.0.1 had a Windows verification failure,
  while CodeQL, Hermes compatibility, and the dependency update PR checks were
  green. The failed Windows job timed out in the heavy task-stop race test at
  Vitest's default 5 second limit; this branch gives that test an explicit 10
  second timeout, but the fix is not proven until the protected Windows job
  passes publicly. Do not start v1.0.2 outreach until the reviewed branch lands
  with a green CI badge.
- Current required-check settings do not require the `workflow-lint` or
  `verify-windows` jobs.
  Treat adding them as repository-settings launch gates, not code changes.
- Open PR #73 is a Dependabot GitHub Actions update for CodeQL v4.37.8 and
  Docker Buildx v4.3.0. It is mergeable with green checks. This branch already
  contains those exact pinned action SHAs, so #73 can merge first or be closed
  as superseded after this branch lands.
- Latest upstream Hermes release: Hermes Agent v0.20.6 (`v2026.8.27`,
  published 2026-08-27).
- Pinned deterministic compatibility fixture: Hermes Agent 0.20.0
  (`v2026.8.3`).
- Forced-pull latest image compatibility smoke: passed with Hermes Agent
  v0.20.6.
- Open upstream Hermes realtime/session discussions are still active.
- The realtime provider RFC includes shipped field evidence from `hermes-talk`
  across OpenAI, xAI/Grok, and Gemini Live plus discussion of core-hosted and
  surface-hosted topologies. Hermes Live Voice should add gateway-hosted
  companion-process evidence, not claim to be the only realtime voice path.
- The open `hermes-talk` docs PR (#97325) is green and specifically signposts
  another community realtime voice plugin. Do not derail it; comment only if
  maintainers ask for broader community implementation wording.

Historical live-provider attempt on 2026-08-29
([receipt](provider-receipts/2026-08-29-local-environment-blocked.md)):

- The attempt happened before the current v1.0.2 release-candidate metadata
  was prepared.
- Default source-checkout `doctor` was blocked: no managed config was installed
  for the active environment, the globally installed Hermes plugin was v0.8.0,
  `hermes` was not on `PATH`, the Hermes API key was not available to the
  active process, the Gemini key was not available, and the gateway LaunchAgent
  was not running.
- The older profile-specific managed config was readable and valid, but it was
  configured for `HERMES_LIVE_PROVIDER="mock"` on a loopback port. It is not
  live-provider evidence.
- No secret values, private prompts, audio, task results, or local absolute
  paths were recorded.

Conclusion: the local environment proves deterministic package quality, but it
does not prove live OpenAI, Gemini, or local speech-to-speech behavior for this
branch.

## External References

- OpenAI Realtime overview: https://developers.openai.com/api/docs/guides/realtime
- OpenAI Realtime WebSocket guide: https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI Realtime model guide: https://developers.openai.com/api/docs/guides/realtime-models-prompting
- OpenAI Realtime client events: https://developers.openai.com/api/reference/resources/realtime/client-events
- Gemini Live overview: https://ai.google.dev/gemini-api/docs/live-api
- Gemini Live tools: https://ai.google.dev/gemini-api/docs/live-api/tools

## Next Actions

1. Push this branch and open the protected PR only after repository-owner review
   approval for the readiness docs.
2. Wait for the protected PR to make the public CI badge green.
3. Add the existing `workflow-lint` and `verify-windows` jobs to required
   branch-protection checks.
4. Resolve Dependabot PR #73 by merging it first or closing it as superseded
   after this branch lands.
5. Release the reviewed v1.0.2 candidate before using the v1.0.2 outreach
   drafts.
6. Apply the GitHub metadata refresh in [Community Sharing](launch-kit.md) so
   public topics match the v1 positioning.
7. Run `npm run audit:public-launch` after the public release, metadata refresh,
   and branch-protection updates. Fix every failure before outreach.
8. Run `npm run audit:upstream-readiness -- --report-only` before upstream
   comments or official-facing wording. Keep wording as community while it
   reports no maintainer acceptance signal.
9. Run one live provider receipt for the provider used in the first public
   outreach message.
10. Submit the pinned Hermes plugin-index entry to the canonical index if it
   exists, or to the maintainer-accepted temporary index until the canonical path
   is published.
11. Refresh the stale `0xNyk/awesome-hermes-agent` entry from v0.9.2 to v1.0.2.
12. Post one focused Discord thread in `#plugins-skills-and-skins`.
13. Post evidence comments to upstream #77111 and #64947, not to #97325 unless
    maintainers ask for a broader docs section.
14. Refresh the pinned Hermes compatibility fixture when v0.20.6 becomes the
    chosen stable baseline.
