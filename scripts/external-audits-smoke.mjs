#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const tempDir = mkdtempSync(join(tmpdir(), "hermes-live-audit-fixtures-"));
const failures = [];

try {
  installFakeTools(tempDir);

  runCase({
    name: "public launch audit accepts exact release metadata",
    script: "public-launch-audit.mjs",
    scenario: "public-pass",
    expectSuccess: true,
    includes: ["Public launch audit ok"],
  });

  runCase({
    name: "public launch audit rejects stale topics and branch checks",
    script: "public-launch-audit.mjs",
    scenario: "public-fail",
    expectSuccess: false,
    includes: [
      "GitHub topic should be removed before launch: terminal",
      "main branch protection does not require check: workflow-lint",
      "main branch protection does not require check: verify-windows",
    ],
  });

  runCase({
    name: "upstream readiness audit rejects absent maintainer acceptance",
    script: "upstream-readiness-audit.mjs",
    scenario: "upstream-no-acceptance",
    expectSuccess: false,
    includes: [
      "No explicit upstream maintainer acceptance signal found",
      "Keep wording as community, not official",
    ],
  });

  runCase({
    name: "upstream readiness audit accepts maintainer-approved community listing",
    script: "upstream-readiness-audit.mjs",
    scenario: "upstream-accepted",
    expectSuccess: true,
    includes: ["Upstream readiness audit ok"],
  });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`External audit smoke failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("External audit smoke ok: public launch and upstream readiness fixtures verified.");

function runCase({ name, script, scenario, expectSuccess, includes }) {
  const result = spawnSync(process.execPath, [resolve(root, "scripts", script)], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HERMES_LIVE_EXTERNAL_AUDIT_FIXTURE: scenario,
      HERMES_LIVE_FIXTURE_PACKAGE_VERSION: packageVersion,
      HERMES_LIVE_PUBLIC_REPO: "bielcarpi/hermes-live-voice",
      HERMES_LIVE_UPSTREAM_REPO: "NousResearch/hermes-agent",
      HERMES_LIVE_PLUGIN_INDEX_REPO: "NousResearch/hermes-plugin-index",
      HERMES_LIVE_TEMP_PLUGIN_INDEX_REPO: "Revell-ai/hermes-plugin-index",
      PATH: `${tempDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const succeeded = result.status === 0;

  if (result.error) {
    failures.push(`${name}: ${result.error.message}`);
    return;
  }
  if (succeeded !== expectSuccess) {
    failures.push(
      `${name}: expected ${expectSuccess ? "success" : "failure"}, got exit ${result.status}\n${output.trim()}`,
    );
    return;
  }
  for (const expected of includes) {
    if (!output.includes(expected)) {
      failures.push(`${name}: missing expected output "${expected}"\n${output.trim()}`);
    }
  }
}

function installFakeTools(directory) {
  const fakeTool = join(directory, "fake-tool.mjs");
  writeFileSync(fakeTool, fakeToolSource(), "utf8");
  chmodSync(fakeTool, 0o755);

  for (const tool of ["gh", "npm"]) {
    writeFileSync(join(directory, tool), posixWrapper(fakeTool, tool), "utf8");
    chmodSync(join(directory, tool), 0o755);
    writeFileSync(join(directory, `${tool}.cmd`), windowsWrapper(fakeTool, tool), "utf8");
  }
}

function posixWrapper(fakeTool, tool) {
  return `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeTool)} ${shellQuote(tool)} "$@"\n`;
}

function windowsWrapper(fakeTool, tool) {
  return `@echo off\r\n"${escapeWindows(process.execPath)}" "${escapeWindows(fakeTool)}" ${tool} %*\r\n`;
}

function shellQuote(value) {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function escapeWindows(value) {
  return value.replace(/"/gu, "\"\"");
}

function fakeToolSource() {
  return `#!/usr/bin/env node
const tool = process.argv[2];
const args = process.argv.slice(3);
const scenario = process.env.HERMES_LIVE_EXTERNAL_AUDIT_FIXTURE || "public-pass";
const packageVersion = process.env.HERMES_LIVE_FIXTURE_PACKAGE_VERSION || "1.0.2";

const expectedDescription = "Self-hosted realtime voice gateway for Hermes Agent. Keep talking while Hermes runs background tasks through local, Gemini Live, and OpenAI Realtime adapters.";
const requiredTopics = [
  "hermes-agent",
  "hermes-plugin",
  "realtime-voice",
  "speech-to-speech",
  "voice-agent",
  "voice-assistant",
  "openai-realtime",
  "gemini-live",
  "local-ai",
  "local-voice",
  "huggingface",
  "self-hosted",
  "browser-sdk",
  "hermes-dashboard",
  "background-tasks",
  "task-supervision",
  "realtime-audio",
  "full-duplex",
  "websocket",
  "typescript",
];
const requiredChecks = [
  "workflow-lint",
  "verify (20)",
  "verify (22)",
  "verify (24)",
  "verify-windows",
  "Analyze (javascript-typescript)",
  "Analyze (python)",
  "dependency-review",
];

if (tool === "npm") {
  if (args[0] === "view" && args[1] === "hermes-live-voice" && args[2] === "version") {
    print(packageVersion);
  }
  fail("unsupported npm command");
}

if (tool !== "gh") fail("unsupported fixture tool");

if (args[0] === "api" && args[1] === "repos/bielcarpi/hermes-live-voice/branches/main/protection") {
  const contexts = scenario === "public-fail"
    ? requiredChecks.filter((check) => !["workflow-lint", "verify-windows"].includes(check))
    : requiredChecks;
  print({ required_status_checks: { contexts, checks: [] } });
}

if (args[0] === "repo" && args[1] === "view") {
  const repo = args[2];
  if (repo === "bielcarpi/hermes-live-voice") {
    const staleTopics = requiredTopics
      .filter((topic) => !["voice-assistant", "websocket"].includes(topic))
      .concat("terminal");
    print({
      name: "hermes-live-voice",
      owner: { login: "bielcarpi" },
      isPrivate: false,
      stargazerCount: 101,
      description: expectedDescription,
      homepageUrl: "https://www.npmjs.com/package/hermes-live-voice",
      hasIssuesEnabled: true,
      hasDiscussionsEnabled: true,
      repositoryTopics: (scenario === "public-fail" ? staleTopics : requiredTopics).map((name) => ({ name })),
      latestRelease: { tagName: "v" + packageVersion },
      url: "https://github.com/bielcarpi/hermes-live-voice",
    });
  }
  if (repo === "NousResearch/hermes-agent") {
    print({
      isPrivate: false,
      url: "https://github.com/NousResearch/hermes-agent",
      pushedAt: "2026-08-29T13:37:08Z",
      latestRelease: { tagName: "v2026.8.27" },
    });
  }
  if (repo === "NousResearch/hermes-plugin-index") {
    print({ isPrivate: false, url: "https://github.com/NousResearch/hermes-plugin-index" });
  }
  if (repo === "Revell-ai/hermes-plugin-index") {
    print({ isPrivate: false, url: "https://github.com/Revell-ai/hermes-plugin-index" });
  }
  fail("unsupported gh repo view target");
}

if (args[0] === "issue" && args[1] === "view") {
  const number = Number(args[2]);
  const titles = {
    77111: "Document external realtime voice provider and session boundary",
    64947: "Clarify Runs authority for conversational gateways",
    87565: "Publish canonical Hermes plugin index",
  };
  if (!titles[number]) fail("unsupported issue");
  print({
    number,
    title: titles[number],
    state: "OPEN",
    updatedAt: "2026-08-29T13:00:00Z",
    url: "https://github.com/NousResearch/hermes-agent/issues/" + number,
    labels: [{ name: "needs-decision" }],
    comments: maintainerComments(),
  });
}

if (args[0] === "pr" && args[1] === "view" && args[2] === "97325") {
  print({
    number: 97325,
    title: "docs: add hermes-talk realtime voice plugin",
    state: "CLOSED",
    isDraft: false,
    mergeable: "MERGEABLE",
    updatedAt: "2026-08-29T13:00:00Z",
    url: "https://github.com/NousResearch/hermes-agent/pull/97325",
    statusCheckRollup: [],
    comments: maintainerComments(),
  });
}

fail("unsupported gh command");

function maintainerComments() {
  if (scenario !== "upstream-accepted") return [];
  return [{
    authorAssociation: "MEMBER",
    body: "Approved. List as a community implementation for the external realtime voice gateway pattern.",
  }];
}

function print(value) {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
}

function fail(message) {
  process.stderr.write(message + "\\n");
  process.exit(1);
}
`;
}
