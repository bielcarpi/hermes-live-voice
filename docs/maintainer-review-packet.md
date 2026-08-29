# Maintainer Review Packet

Status: draft packet for Hermes ecosystem review.

Use this packet after the reviewed v1.0.2 commit is public. It is designed for
maintainers, plugin-index reviewers, and Hermes builders who need to decide
whether Hermes Live Voice is safe and useful enough to reference as a community
external realtime voice gateway.

This packet does not claim official NousResearch status.

## Review Request

Hermes Live Voice is a self-hosted realtime voice gateway and Dashboard plugin
for Hermes Agent.

The proposed review question is:

```txt
Should Hermes docs and plugin discovery describe the external realtime voice
gateway pattern, with Hermes Live Voice listed as one community implementation?
```

The requested wording before explicit maintainer acceptance is:

```txt
Community MIT realtime voice gateway and Dashboard plugin for Hermes Agent.
```

The target wording after explicit maintainer acceptance is:

```txt
Implements the documented external realtime voice gateway pattern for Hermes Agent.
```

## What To Review

Review these surfaces first:

1. [README](../README.md) for the user-facing install path, product boundary,
   and limitations.
2. [Architecture](architecture.md) for the provider, gateway, and Hermes
   responsibility split.
3. [Security model](security.md) for credential handling, origins, relay
   behavior, task state, and public-bind guidance.
4. [Maintainer readiness audit](maintainer-readiness-audit.md) for the evidence
   matrix and remaining blockers.
5. [Live provider testing](live-provider-testing.md) for the manual evidence
   gate that CI cannot cover.
6. [Upstream integration RFC](upstream-integration-rfc.md) for the proposed
   Hermes contract and docs path.

## Proven Locally

Current deterministic evidence for the v1.0.2 candidate:

- `npm run verify` passes.
- `npm audit --audit-level=moderate` reports 0 vulnerabilities.
- `npm pack --dry-run` produces `hermes-live-voice-1.0.2.tgz`.
- The packed package installs into a clean temporary prefix and exposes the
  `hermes-live` CLI.
- The bundled Hermes plugin and Dashboard assets pass local smoke tests.
- The package/plugin/Dashboard versions match.
- The pinned Hermes Agent v0.20.0 compatibility smoke passes.
- The floating current Hermes Agent image smoke passes and reports v0.20.6.
- `uvx --from hermes-plugin-guard hpg scan plugins/hermes-live --fail-on high`
  passes with no high findings.
- A pinned OpenSSF Scorecard workflow is prepared for repository-level security
  health reporting.
- Public positioning checks reject false official claims and Saturday-specific
  copy.
- External audit fixtures prove the public launch and upstream readiness gates
  fail on stale metadata, missing branch checks, and absent maintainer
  acceptance, and pass on accepted community-listing evidence.
- Maintainer readiness checks keep package counts, docs counts, version parity,
  and launch-boundary evidence synchronized.
- `npm run audit:upstream-readiness -- --report-only` gives a live read-only
  report of upstream issues, the `hermes-talk` docs PR, plugin-index
  availability, and maintainer-acceptance blockers.

## Not Proven Yet

Do not claim these until separate evidence exists:

- current live OpenAI Realtime behavior for v1.0.2;
- current live Gemini Live behavior for v1.0.2;
- current local Hugging Face speech-to-speech hardware behavior for v1.0.2;
- public OpenSSF Scorecard result for the v1.0.2 branch;
- official Hermes endorsement;
- production readiness for every provider, region, account, and hardware shape;
- recovery of in-progress Hermes work after a Hermes Agent restart.

The correct current claim is that provider paths are implemented and
deterministically covered, while live-provider receipts are still required for
release-specific provider claims.

## Plugin Boundary

The Hermes plugin is intentionally small. It provides:

- `hermes_live_status`;
- `/hermes-live`;
- `/hermes-live ready`;
- a Dashboard Live Voice tab;
- an authenticated same-origin relay to the companion gateway.

The plugin does not run provider WebSockets, audio pipelines, provider SDKs, or
the task supervisor inside Hermes. Those belong to the companion gateway
installed by the npm package.

## Release Candidate Review PR

Suggested repository PR title:

```txt
release: prepare Hermes Live Voice v1.0.2 for maintainer review
```

Suggested PR body:

```md
## Why

Prepare Hermes Live Voice v1.0.2 as an official-quality community integration
candidate for Hermes Agent realtime voice workflows.

The core boundary is unchanged: realtime providers handle speech and
turn-taking, Hermes owns tools/memory/runs, and this gateway owns the
authenticated client protocol, task supervision, progress, stop/status, and
reconnect projection.

## What changed

- Tightens README, package metadata, plugin metadata, release docs, and public
  positioning around the "keep talking while Hermes works" workflow.
- Adds maintainer readiness, upstream integration, provider testing, community
  launch, plugin-index, and first-contributor issue artifacts.
- Adds `check:positioning` and `check:maintainer-readiness` gates to prevent
  false official claims, stale evidence counts, and version drift.
- Adds `check:external-audits` fixtures for the public launch and upstream
  readiness gates.
- Updates the Gemini SDK on the same major line and strengthens local realtime
  adapter close coverage.

## Verification

- `npm run verify`
- `npm audit --audit-level=moderate`
- `npm pack --dry-run`
- `docker build -t hermes-live-voice:readiness-1.0.2 .`
- `npm run check:hermes-compatibility`
- `HERMES_COMPATIBILITY_IMAGE=nousresearch/hermes-agent:latest HERMES_COMPATIBILITY_EXPECTED_VERSION='*' npm run check:hermes-compatibility`
- `uvx --from hermes-plugin-guard hpg scan plugins/hermes-live --fail-on high --format text`
- changed-file credential marker scan for common API key, bearer token, GitHub
  token, cloud access key, and private-key patterns
- `npm view hermes-live-voice@1.0.2 version --json` returns 404 before release

## Remaining external gates

- Publish the reviewed v1.0.2 release.
- Capture at least one current live-provider receipt before provider-specific
  outreach claims.
- Submit the pinned plugin-index entry when the canonical or
  maintainer-accepted temporary index path is available.
- Post evidence-focused upstream comments only after the public release exists.
- Keep official wording disabled while `npm run audit:upstream-readiness` finds
  no maintainer acceptance signal.

This PR does not claim official NousResearch status.
```

## Post-Release Public Sequence

After the reviewed commit lands on `main`:

1. Confirm `npm view hermes-live-voice@1.0.2 version --json` is still absent.
2. Tag the exact reviewed commit as `v1.0.2`.
3. Let the release workflow create the immutable GitHub release and npm package.
4. Verify npm provenance, exact version install, CLI help, plugin status, and
   GitHub release assets.
5. Generate the pinned plugin-index entry from the public commit:

   ```sh
   PLUGIN_INDEX_REF="$(git rev-parse HEAD)" node scripts/plugin-index-entry.mjs
   ```

6. Run one live-provider receipt for the provider used in outreach.
7. Apply the GitHub metadata refresh in [Community Sharing](launch-kit.md).
8. Submit the plugin-index PR to the canonical index if it exists; otherwise use
   the maintainer-accepted temporary index and keep direct pinned install
   documented.
9. Open the first contributor issues from
   [Community Issue Drafts](community-issue-drafts.md).
10. Post once in the Hermes-specific Discord channel with the v1.0.2 release
    link and provider evidence boundary.

## Maintainer Acceptance Criteria

The project should not use stronger wording until a maintainer explicitly
accepts all of these:

- external realtime gateways are an acceptable Hermes docs pattern;
- Hermes Live Voice can be listed as a community implementation;
- the exact wording is approved;
- any required disclaimers or contract limitations are included.

If maintainers only accept the pattern, keep the README wording as a community
project and link the upstream docs neutrally.
