#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
const dashboardManifest = JSON.parse(read("plugins/hermes-live/dashboard/manifest.json"));
const pluginManifest = read("plugins/hermes-live/plugin.yaml");
const socialPreviewPng = readFileSync(resolve(root, "assets/social-preview.png"));
const audit = read("docs/maintainer-readiness-audit.md");
const launchKit = read("docs/launch-kit.md");
const maintainerReviewPacket = read("docs/maintainer-review-packet.md");
const communityIssueDrafts = read("docs/community-issue-drafts.md");
const readme = read("README.md");
const scorecardWorkflow = read(".github/workflows/scorecard.yml");
const ciWorkflow = read(".github/workflows/ci.yml");

const pluginVersion = scalar(pluginManifest, "version");
const versionFields = {
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock.json packages root": packageLock.packages?.[""]?.version,
  "plugins/hermes-live/plugin.yaml": pluginVersion,
  "plugins/hermes-live/dashboard/manifest.json": dashboardManifest.version,
};

for (const [field, version] of Object.entries(versionFields)) {
  if (version !== packageJson.version) {
    failures.push(`${field} version ${String(version)} does not match package.json ${packageJson.version}`);
  }
}

if (packageJson.scripts?.["check:external-audits"] !== "node scripts/external-audits-smoke.mjs") {
  failures.push("package.json must expose check:external-audits for deterministic external audit fixtures");
}
if (!packageJson.scripts?.verify?.includes("npm run check:external-audits")) {
  failures.push("npm run verify must include check:external-audits before release/outreach claims");
}

if (!isPng(socialPreviewPng)) {
  failures.push("assets/social-preview.png must be a PNG file for GitHub social preview settings");
} else {
  const width = socialPreviewPng.readUInt32BE(16);
  const height = socialPreviewPng.readUInt32BE(20);
  if (width !== 1280 || height !== 640) {
    failures.push(`assets/social-preview.png must be 1280x640, got ${width}x${height}`);
  }
}
if (socialPreviewPng.byteLength >= 1_000_000) {
  failures.push("assets/social-preview.png must stay under GitHub's 1 MB social preview limit");
}

const markdownCount = collectMarkdownFiles(root).length;
if (!audit.includes(`Markdown docs check: passed across ${markdownCount} Markdown files.`)) {
  failures.push(`maintainer audit must reference the current Markdown file count: ${markdownCount}`);
}

const packageFileCount = packageFileCountFromNpmPack();
for (const expected of [
  `Packed package smoke: passed with ${packageFileCount} files in the release-candidate tarball.`,
  `npm pack --dry-run\`: passed for \`hermes-live-voice-${packageJson.version}.tgz\` with ${packageFileCount} files.`,
  `Packed package smoke: passed with ${packageFileCount} files in the v${packageJson.version} tarball.`,
]) {
  if (!audit.includes(expected)) {
    failures.push(`maintainer audit is missing current package evidence: ${expected}`);
  }
}

for (const expected of [
  `Local release target: v${packageJson.version}.`,
  `npm did not yet contain \`hermes-live-voice@${packageJson.version}\` at audit time`,
  "Do not start v1.0.2 outreach until the reviewed branch lands with a green CI badge.",
  "Public npm latest is still v1.0.1",
  "local v1.0.2 package metadata removes those terms and must be published before npm-focused outreach",
  "Public GHCR image path: `ghcr.io/bielcarpi/hermes-live-voice:1.0.1` resolves as an OCI index with Linux `amd64` and `arm64` manifests.",
  "GitHub package-settings API check: not proven because the active `gh` token lacks `read:packages`",
  "GitHub Actions workflow lint: passed with `actionlint`.",
  "Public launch audit: prepared as `npm run audit:public-launch`.",
  "reviewed release, launch topics, npm homepage, Issues, Discussions, and required branch-protection checks are public.",
  "Upstream readiness audit: prepared as `npm run audit:upstream-readiness`.",
  "reads live Hermes upstream issues, the `hermes-talk` docs PR, plugin-index availability, public release state, and maintainer-acceptance signals.",
  "`npm run audit:upstream-readiness -- --report-only`: ran successfully as a read-only report and correctly identified external blockers",
  "no explicit upstream maintainer acceptance signal was found in labels or maintainer/collaborator comments on the tracked threads.",
  "`check:external-audits`: included in `npm run verify` and fixture-checks the public launch and upstream readiness scripts",
  "stale metadata, missing branch checks, absent maintainer acceptance, and accepted community listing states.",
  "The existing `workflow-lint` and `verify-windows` CI jobs are not currently required and should be added before launch.",
  "`assets/social-preview.png`, rendered at 1280x640 and under 1 MB",
  "Historical live-provider attempt on 2026-08-29",
  "Live-provider evidence is complete. | Not proven",
  "First-contributor path is prepared. | Proven locally",
  "Existing community realtime work is respected. | Proven locally",
  "Hermes Live Voice should add gateway-hosted companion-process evidence, not claim to be the only realtime voice path.",
  "Do not derail it; comment only if maintainers ask for broader community implementation wording.",
  "Do not use stronger wording unless maintainers approve it in writing.",
  "`check:scripts`: included in `npm run verify` and syntax-checks every JavaScript maintenance script",
]) {
  if (!includesText(audit, expected)) {
    failures.push(`maintainer audit is missing required boundary/evidence text: ${expected}`);
  }
}

for (const expected of [
  "Community issue drafts",
  "Live provider testing",
  "Maintainer review packet",
  "Maintainer readiness audit",
  "This is a community project, not an official NousResearch distribution.",
  "Hermes subdirectory plugin installs are currently better treated as pinned review installs",
]) {
  if (!includesText(readme, expected)) {
    failures.push(`README is missing required readiness/distribution link or boundary: ${expected}`);
  }
}

for (const expected of [
  `Use \`v${packageJson.version}\` for the next launch after the reviewed release is tagged`,
  "Public latest is v1.0.1; local package metadata has been tightened for the next release.",
  "Confirm the public CI badge is green after the protected PR lands.",
  "Add the existing `workflow-lint` and `verify-windows` jobs to required branch-protection checks.",
  "Run `npm run check:external-audits` to prove the audit fixtures.",
  "Social preview: [assets/social-preview.png]",
  "Submit this only after the reviewed public commit exists",
  "Treat the direct subdirectory command as a pinned review/install escape hatch",
  "Do not claim a provider path is live-verified for the current release",
  "Open two or three narrow issues labeled `good first issue` or `help wanted`",
  "Do not cross-post to broad communities",
  "Do not add it before a result exists",
  "Run `npm run audit:public-launch` and fix any public metadata, release, or branch-protection failure before outreach.",
  "npm run audit:upstream-readiness -- --report-only",
  "The fixture smoke proves the audit scripts' expected pass/fail behavior without network access.",
  "Do not use official wording while this audit reports no maintainer acceptance signal.",
  "Branch Protection Launch Gate",
  "Do not use the broad `CodeQL` aggregate status as a substitute for the two language-specific analysis jobs.",
  "Required checks:",
  "100-Star Adoption Plan",
  "Do not buy, trade, coordinate, or ask friends for artificial stars.",
  "Do not backdate or rewrite public history to simulate a longer project.",
  "Do not publish a demo recording.",
  "Hermes voice plus durable background runs.",
  "`hermes-talk` is the stronger existing proof that one realtime session contract can carry multiple providers and surface types.",
  "Do not comment on the `hermes-talk` docs PR unless maintainers explicitly ask for a broader community-implementation section.",
]) {
  if (!includesText(launchKit, expected)) {
    failures.push(`launch kit is missing required launch safety text: ${expected}`);
  }
}

for (const expected of [
  "Should Hermes docs and plugin discovery describe the external realtime voice gateway pattern",
  "This packet does not claim official NousResearch status.",
  "Do not claim these until separate evidence exists",
  "The plugin does not run provider WebSockets, audio pipelines, provider SDKs, or the task supervisor inside Hermes.",
  "public OpenSSF Scorecard result for the v1.0.2 branch",
  "External audit fixtures prove the public launch and upstream readiness gates",
  "Adds `check:external-audits` fixtures for the public launch and upstream readiness gates.",
  "npm run audit:upstream-readiness -- --report-only",
  "release: prepare Hermes Live Voice v1.0.2 for maintainer review",
  "This PR does not claim official NousResearch status.",
]) {
  if (!includesText(maintainerReviewPacket, expected)) {
    failures.push(`maintainer review packet is missing required text: ${expected}`);
  }
}

for (const expected of [
  "provider receipt: OpenAI Realtime",
  "provider receipt: Gemini Live",
  "hardware receipt: local voice on Apple Silicon",
  "docs: add clean Dashboard Live Voice screenshots",
  "research: Linux path for local voice runtime",
]) {
  if (!includesText(communityIssueDrafts, expected)) {
    failures.push(`community issue drafts are missing entry: ${expected}`);
  }
}

for (const expected of [
  "ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc",
  "github/codeql-action/upload-sarif@db488ddef3bf6cb639b32c2e9a7c0a7ea8271d28",
  "publish_results: true",
  "id-token: write",
  "security-events: write",
]) {
  if (!includesText(scorecardWorkflow, expected)) {
    failures.push(`OpenSSF Scorecard workflow is missing required pinned security reporting text: ${expected}`);
  }
}

for (const expected of [
  "workflow-lint:",
  'version="1.7.12"',
  'archive="actionlint_${version}_linux_amd64.tar.gz"',
  "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  "sha256sum --check -",
  "Lint GitHub Actions workflows",
]) {
  if (!includesText(ciWorkflow, expected)) {
    failures.push(`CI workflow is missing required pinned actionlint gate: ${expected}`);
  }
}

if (failures.length > 0) {
  console.error(`Maintainer readiness smoke failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(
  `Maintainer readiness smoke ok: v${packageJson.version}, ${markdownCount} docs, ${packageFileCount} package files, and launch boundaries verified.`,
);

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function includesText(source, expected) {
  return normalizeWhitespace(source).includes(normalizeWhitespace(expected));
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function scalar(source, name) {
  const match = new RegExp(`^${escapeRegExp(name)}:\\s*(.+?)\\s*$`, "mu").exec(source);
  if (!match) throw new Error(`missing scalar ${name}`);
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!new Set([".git", "dist", "node_modules"]).has(entry.name)) {
        files.push(...collectMarkdownFiles(resolve(directory, entry.name)));
      }
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}

function isPng(buffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer.subarray(0, pngSignature.length).equals(pngSignature);
}

function packageFileCountFromNpmPack() {
  const output = execFileSync("npm", ["pack", "--json", "--dry-run"], {
    cwd: root,
    encoding: "utf8",
  });
  const jsonStart = output.search(/(?:^|\n)\s*\[\s*\{/u);
  if (jsonStart === -1) {
    throw new Error(`npm pack --json --dry-run did not emit JSON metadata:\n${output}`);
  }
  const pack = JSON.parse(output.slice(jsonStart).trim())[0];
  if (!pack || pack.name !== packageJson.name || pack.version !== packageJson.version) {
    throw new Error("npm pack --json --dry-run returned unexpected package metadata");
  }
  return pack.files.length;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
