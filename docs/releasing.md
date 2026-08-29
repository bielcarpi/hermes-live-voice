# Releasing

Releases are tag-driven, immutable, and reproducible from protected `main`. Prereleases publish to npm's `next` tag; stable releases publish to `latest`.

## Version And Evidence Policy

Stable releases require the deterministic suite, a clean packed-package install, Docker runtime proof, and real Hermes integration. Run a live provider check whenever a release changes that provider's handshake, session configuration, tool delivery, or default model. A change that only normalizes a documented provider event may instead use the official event contract plus a deterministic adapter fixture. Record live attempts and external blockers; a quota or account failure is not a passing provider check.

Release notes must distinguish:

- client/provider disconnect continuation;
- gateway-restart recovery while the same Hermes process remains alive;
- the honest lack of in-progress recovery after a Hermes Agent restart;
- fenced `dispatch_unknown` behavior;
- OpenAI out-of-band versus Gemini best-effort spoken notifications;
- the absence of interactive approvals.

## Prepare

1. Move user-visible changelog entries from `Unreleased` into the exact version section.
2. Keep these versions identical:
   - `package.json`
   - `package-lock.json`
   - `plugins/hermes-live/plugin.yaml`
   - `plugins/hermes-live/dashboard/manifest.json`
3. Confirm provider defaults against current official documentation.
4. Check the current upstream Hermes Agent release. If it differs from the
   pinned fixture, either refresh the fixture or record a successful
   latest-image compatibility workflow before making current-upstream claims.
5. From a clean checkout, run:

   ```sh
   npm ci
   npm run verify
   npm run check:scripts
   npm run check:external-audits
   npm run check:workflow-pins
   npm run check:positioning
   npm run check:maintainer-readiness
   npm run check:hermes-compatibility
   node dist/cli.js launch-check
   npm audit --audit-level=moderate
   npm pack --dry-run
   docker build -t hermes-live-voice:release .
   ```

6. Run `npm run check:live-provider` for each changed provider handshake/default model and record provider, model, region when relevant, date, and outcome with the [provider compatibility receipt template](provider-compatibility-receipt-template.md). For event-only adapter changes, record the official contract and deterministic fixture instead.
7. Install the packed tarball in a clean temporary directory and run CLI/plugin/mock smokes.
8. Generate the pinned plugin-index entry from the verified commit. Submit it
   only after checking whether the canonical Hermes index is published or a
   temporary index is still the maintainer-accepted path:

   ```sh
   PLUGIN_INDEX_REF="$(git rev-parse HEAD)" node scripts/plugin-index-entry.mjs
   ```

9. After release publication and GitHub metadata updates, run the external
   launch gate:

   ```sh
   npm run audit:public-launch
   ```

   This command reads GitHub and npm state. It is intentionally not part of
   `npm run verify`, and it should fail until the reviewed release, launch
   topics, and required branch-protection checks are public.
10. Before upstream or official-facing outreach, run the read-only upstream
    gate:

   ```sh
   npm run audit:upstream-readiness -- --report-only
   ```

   This command reads live Hermes upstream issues, the `hermes-talk` docs PR,
   plugin-index availability, and public project release state. It is expected
   to report blockers until maintainers accept an external gateway/docs path.
11. Confirm `git status --short` is empty and every required GitHub check is green.

## Release Proof Gate

Before tagging a stable release, record evidence for:

- branch protection that requires workflow lint, Linux verify, Windows verify,
  CodeQL, and dependency review for `main`.
- `hermes-live launch-check` with a real provider and exact Hermes worker output.
- real Hermes submission, SSE completion, retained result, and exact stop.
- the pinned official Hermes v0.20.0 image, required capabilities, plugin discovery, and a current latest-image check when upstream has moved beyond the pinned baseline.
- immediate receipt and a second conversation turn while a task remains active.
- default exclusive serialization plus opt-in disjoint read-only concurrency.
- client detach/reconnect with snapshot and notification deduplication.
- gateway restart using the same state file while Hermes stays alive.
- Hermes restart producing `unknown`, not a fabricated terminal result.
- fail-closed approval deny-all plus exact stop, with no approval UI.
- a persistent Docker state volume with non-root/read-only hardening.
- live session smoke for each changed provider handshake/default, plus official event fixtures and deterministic adapter coverage for event-only normalization changes.
- browser/Dashboard/terminal and clean-package installation smokes.
- pinned Hermes plugin-index entry generation for `plugins/hermes-live`.
- script syntax smoke for JavaScript maintenance scripts, including release and
  external audit helpers.
- external audit fixture smoke for the public launch and upstream readiness
  scripts, including expected pass and failure states.
- positioning smoke for community, non-official, non-Saturday public copy.
- workflow pin smoke for immutable external GitHub Action references.
- public launch audit for release, GitHub metadata, topics, npm latest version,
  and required branch-protection checks.
- upstream readiness audit for maintainer acceptance, canonical plugin-index
  availability, and non-competitive coordination with existing realtime voice
  work.
- maintainer readiness smoke so package counts, docs counts, version parity,
  and launch-boundary evidence stay synchronized.

Repeat the gate on the final commit and complete an appropriate soak window. Keep recent live evidence for every advertised provider, and record any account, quota, region, or model-access blocker without relabeling it as a pass. Document manual audio/device coverage; tests cannot prove microphones, autoplay, perceived latency, or provider speech quality on untested hardware.

## Tag And GitHub Release

Create an annotated tag from the verified commit:

```sh
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The repository ruleset prevents moving/deleting `v*` tags. The release workflow:

1. serializes version tags and reruns verification/audit;
2. builds the npm tarball and SHA-256 manifest in a read-only job;
3. extracts the exact matching `CHANGELOG.md` section;
4. creates and verifies a GitHub release with exactly the tarball and `SHA256SUMS`;
5. publishes the release and activates immutability;
6. publishes the exact verified tarball to npm when `PUBLISH_NPM=true`.

The write-capable release job does not check out or execute repository code. Existing drafts/assets must match exactly on rerun; the workflow does not replace mismatched immutable artifacts.

Download both assets into one directory and verify with:

```sh
shasum -a 256 -c SHA256SUMS
```

## npm Trusted Publication

The OIDC publication job uses the protected `npm` environment, Node 24, and a pinned npm 11 CLI. It downloads and verifies the prepared artifact without checking out or installing repository dependencies under the publishing credential.

Configure npm's trusted publisher exactly:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `bielcarpi` |
| Repository | `hermes-live-voice` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

Enter `release.yml`, not its repository path. Keep the GitHub `npm` environment restricted to `v*` tags plus protected `main` for recovery, require a reviewer, and do not add `NPM_TOKEN`.

Once trusted publication is active, restrict conventional token publication:

```sh
npm access set mfa=publish hermes-live-voice
```

The registry verification job checks exact integrity, expected `next`/`latest` dist-tag, provenance, signatures, clean exact-version install, executable version, and help output. An already-published version is accepted only if its integrity exactly matches the verified tarball.

## Recover A Failed Tag Publish

Never move/delete a protected version tag or replace immutable release assets. If npm has not accepted the version and only the workflow needs repair:

1. fix `.github/workflows/release.yml` through the protected pull-request path;
2. wait for required checks on `main`;
3. confirm the npm version is absent or has the exact expected integrity;
4. dispatch from protected `main`:

   ```sh
   gh workflow run release.yml --ref main -f release_tag=vX.Y.Z
   ```

5. review/approve the `npm` environment deployment.

The recovery path checks out the immutable tag, requires it in protected `main` history, and rejects differences from the tag outside `release.yml`. If source, tests, or documentation changed, publish a new version instead.

## Post-Release Readback

- Install the exact registry version into a clean directory.
- Run `hermes-live --version`, `hermes-live --help`, `hermes-live plugin status`, and the mock quick start.
- Verify GitHub asset checksums and that the release body begins with the exact changelog section.
- Verify npm version, dist-tag, integrity, provenance, signatures, repository URL, README rendering, and executable.
- Confirm GitHub and npm point to the same semantic version before announcing it.
- Recheck `/v1/capabilities` from the released container/package and archive the proof matrix with release notes.
