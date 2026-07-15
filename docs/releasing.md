# Releasing

Releases are tag-driven and must be reproducible from a clean `main` branch.

## Prepare

1. Move user-visible entries from `Unreleased` into a versioned changelog section.
2. Update `package.json`, `package-lock.json`, `plugins/hermes-live/plugin.yaml`, and `plugins/hermes-live/dashboard/manifest.json` to the same semantic version.
3. Confirm the documented provider defaults against official provider documentation.
4. Run the complete local gate:

   ```sh
   npm ci
   npm run verify
   npm audit --audit-level=moderate
   npm pack --dry-run
   docker build -t hermes-live-voice:release .
   ```

5. Run `npm run check:live-provider` for every provider whose adapter or default model changed. Record the tested model and date in the release notes.
6. Confirm `git status --short` is empty and all required GitHub checks are green.

## Tag and GitHub release

Create a signed or annotated tag from the verified commit:

```sh
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The repository ruleset prevents updates or deletion of `v*` tags, and immutable releases protect their tags and assets after publication. The release workflow serializes version tags, reruns verification, audits dependencies, packs the npm tarball, and records its SHA-256 checksum in a read-only job. The checksum manifest stores only the tarball basename so users can download both release assets into one directory and verify them directly with `sha256sum --check SHA256SUMS` (or `shasum -a 256 -c SHA256SUMS` on macOS). A separate job with `contents: write` downloads only those artifacts and creates the GitHub release; it never checks out or executes repository/dependency code with the write credential. If a rerun finds an existing release or recoverable draft, it requires every existing asset to match instead of replacing it.

## npm publication

The workflow publishes only when the repository variable `PUBLISH_NPM` is `true`. Its OIDC job uses the protected `npm` environment, Node 24, and a pinned npm 11 CLI. It verifies the downloaded tarball and publishes that exact artifact without checking out or installing repository dependencies under the OIDC credential. Stable versions use the `latest` dist-tag and prereleases use `next`.

Configure the one npm trusted publisher with these exact values:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `bielcarpi` |
| Repository | `hermes-live-voice` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | `npm publish` |

Enter only `release.yml`, not `.github/workflows/release.yml`. The workflow filename must already exist on the default branch. Keep the GitHub environment restricted to version tags matching `v*`, require a release approval, and do not add an `NPM_TOKEN`.

The package must exist before its trusted publisher can be configured. For the initial claim only, enable account-level npm 2FA and manually publish the exact verified tarball from the existing GitHub release:

```sh
gh release download vX.Y.Z --pattern 'hermes-live-voice-X.Y.Z.tgz' --pattern SHA256SUMS
shasum -a 256 -c SHA256SUMS
NPM_CONFIG_PROVENANCE=false npm publish ./hermes-live-voice-X.Y.Z.tgz --access public --ignore-scripts
npm view hermes-live-voice@X.Y.Z name version dist.integrity repository --json
```

After the registry readback succeeds, create the trusted publisher, set `PUBLISH_NPM=true`, and restrict conventional token-based package publication. Future version tags must publish only through the protected OIDC workflow.

Publication is retry-safe: an existing version is accepted only when its registry integrity exactly matches the verified tarball. A separate job with no repository or OIDC permissions then verifies the registry integrity, expected dist-tag, SLSA provenance, clean exact-version install, executable version/help output, and registry signatures.

## Post-release

- Install the exact released package or tarball into a clean temporary directory.
- Run `hermes-live --help`, `hermes-live plugin status`, and the mock quick start.
- Download the GitHub release tarball and `SHA256SUMS` into one directory, verify the checksum, and inspect the release notes.
- Verify the npm package metadata, dist-tag, provenance, signatures, README rendering, and executable from a clean registry install.
- Confirm the npm package page and GitHub release both point to the same version before announcing the release.
