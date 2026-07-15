# Releasing

Releases are tag-driven, immutable, and reproducible from protected `main`. Prereleases publish to npm's `next` tag; stable releases publish to `latest`.

## Version And Evidence Policy

Use a prerelease such as `0.5.0-beta.1` while a new protocol or durability contract is gathering real-world evidence. Do not promote a beta to `0.5.0` merely because automated tests pass.

For the v0.5 task-supervisor line, release notes must distinguish:

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
4. From a clean checkout, run:

   ```sh
   npm ci
   npm run verify
   npm audit --audit-level=moderate
   npm pack --dry-run
   docker build -t hermes-live-voice:release .
   ```

5. Run `npm run check:live-provider` for each changed provider/default model and record provider, model, region when relevant, and date.
6. Install the packed tarball in a clean temporary directory and run CLI/plugin/mock smokes.
7. Confirm `git status --short` is empty and every required GitHub check is green.

## v0.5 Proof Gate

Before tagging a v0.5 beta, record evidence for:

- real Hermes submission, SSE completion, retained result, and exact stop;
- immediate receipt and a second conversation turn while a task remains active;
- exclusive serialization and disjoint read-only concurrency;
- client detach/reconnect with snapshot and notification deduplication;
- gateway restart using the same state file while Hermes stays alive;
- Hermes restart producing `unknown`, not a fabricated terminal result;
- fail-closed approval deny-all plus exact stop, with no approval UI;
- a persistent Docker state volume with non-root/read-only hardening;
- real OpenAI/Gemini session smoke for each advertised provider;
- browser/Dashboard/terminal and clean-package installation smokes.

Before promoting the stable v0.5 tag, repeat the gate on the final commit and complete an appropriate soak window. Document any manual audio/device coverage; tests cannot prove microphones, autoplay, perceived latency, or provider speech quality on untested hardware.

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
- Recheck `/v1/capabilities` from the released container/package and archive the v0.5 proof matrix with release notes.
