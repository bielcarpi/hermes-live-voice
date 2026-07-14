# Releasing

Releases are tag-driven and must be reproducible from a clean `main` branch.

## Prepare

1. Move user-visible entries from `Unreleased` into a versioned changelog section.
2. Update `package.json` and `package-lock.json` to the same semantic version.
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

The release workflow reruns verification, audits dependencies, packs the npm tarball, and records its SHA-256 checksum in a read-only job. A separate job with `contents: write` downloads only those artifacts and creates the GitHub release; it never checks out or executes repository/dependency code with the write credential.

## npm publication

The workflow contains an optional npm trusted-publishing job. It runs only when the repository variable `PUBLISH_NPM` is set to `true` and the npm package has a trusted publisher configured for this GitHub repository and workflow. That job deliberately uses Node 24, installs the pinned npm 11 CLI without lifecycle scripts, verifies the staged tarball checksum/version, and publishes that already-verified artifact without checking out or installing project dependencies under the OIDC credential.

Before enabling it:

1. Claim `hermes-live-voice` on npm.
2. Configure npm trusted publishing for `bielcarpi/hermes-live-voice` and `.github/workflows/release.yml`.
3. Create a protected GitHub environment named `npm` if release approval is desired.
4. Set the repository variable `PUBLISH_NPM=true`.
5. Verify the package name, version, files, provenance, README rendering, and executable from the packed tarball.

Do not add a long-lived npm token when trusted publishing is available.

## Post-release

- Install the exact released package or tarball into a clean temporary directory.
- Run `hermes-live --help`, `hermes-live plugin status`, and the mock quick start.
- Verify the GitHub release asset and release notes.
- Verify the npm package and provenance when npm publishing is enabled.
- Update README install instructions only after the npm registry readback succeeds.
