import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { extractReleaseNotes } from "./extract-release-notes.mjs";

const sample = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "## 0.4.0 - 2026-07-15",
  "",
  "- First shipped change.",
  "- Second shipped change.",
  "",
  "## 0.3.2 - 2026-07-15",
  "",
  "- Previous release.",
  "",
].join("\n");

assert.equal(
  extractReleaseNotes(sample, "0.4.0"),
  "## 0.4.0 - 2026-07-15\n\n- First shipped change.\n- Second shipped change.\n",
);
assert.equal(
  extractReleaseNotes("## 1.0.0-beta.1\n\nPreview.\n", "1.0.0-beta.1"),
  "## 1.0.0-beta.1\n\nPreview.\n",
);
assert.throws(() => extractReleaseNotes(sample, "0.4"), /no exact section/);
assert.throws(
  () => extractReleaseNotes("## 0.4.0\n\n<!-- placeholder -->\n", "0.4.0"),
  /must not contain HTML comments/,
);
assert.throws(
  () => extractReleaseNotes("## 0.4.0\n\nShipped.\n<!-- hidden -->\n", "0.4.0"),
  /must not contain HTML comments/,
);
assert.throws(
  () => extractReleaseNotes("## 0.4.0\n\nShipped.\n-->\n", "0.4.0"),
  /must not contain HTML comments/,
);
assert.throws(
  () => extractReleaseNotes("## 0.4.0\n\nOne.\n\n## 0.4.0 - 2026-07-15\n\nTwo.\n", "0.4.0"),
  /multiple exact sections/,
);

const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
assert.match(
  releaseWorkflow,
  /else\n\s+verify_release_notes_prefix "\$release_json"\n\s+echo "Existing published release matches the verified artifacts\."/,
  "Published-release reruns must verify the immutable body starts with the packaged changelog section.",
);
assert.doesNotMatch(
  releaseWorkflow,
  /PUBLISHED_NOW/,
  "Registry verification must not skip dist-tag checks on idempotent or recovery runs.",
);
assert.match(
  releaseWorkflow,
  /\[ "\$registry_tag" = "\$PACKAGE_VERSION" \]; then/,
  "Registry polling must require the expected npm dist-tag.",
);
assert.match(
  releaseWorkflow,
  /\[ "\$registry_tag" != "\$PACKAGE_VERSION" \]; then/,
  "Registry verification must fail when the expected npm dist-tag drifts.",
);

const workDir = mkdtempSync(join(tmpdir(), "hermes-live-release-notes-"));
try {
  const input = join(workDir, "CHANGELOG.md");
  const output = join(workDir, "nested", "RELEASE_NOTES.md");
  writeFileSync(input, sample, "utf8");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./extract-release-notes.mjs", import.meta.url)),
      "--version",
      "0.4.0",
      "--input",
      input,
      "--output",
      output,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, "utf8"), extractReleaseNotes(sample, "0.4.0"));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log("Release notes extraction smoke ok");
