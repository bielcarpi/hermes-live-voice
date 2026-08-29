#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const targetVersion = packageJson.version;
const targetTag = `v${targetVersion}`;
const repo = process.env.HERMES_LIVE_PUBLIC_REPO ?? "bielcarpi/hermes-live-voice";
const allowPendingRelease = process.argv.includes("--allow-pending-release");
const failures = [];
const warnings = [];

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
const forbiddenTopics = [
  "ai-agents",
  "nous-research",
  "terminal",
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

const repoState = ghJson([
  "repo",
  "view",
  repo,
  "--json",
  "name,owner,isPrivate,stargazerCount,description,homepageUrl,hasIssuesEnabled,hasDiscussionsEnabled,repositoryTopics,latestRelease,url",
]);
const topicNames = new Set((repoState.repositoryTopics ?? []).map((topic) => topic.name));
const latestRelease = repoState.latestRelease?.tagName ?? "";
const branchProtection = ghJson(["api", `repos/${repo}/branches/main/protection`]);
const requiredContexts = collectRequiredContexts(branchProtection);
const npmVersion = npmJson(["view", packageJson.name, "version", "--json"]);

if (repoState.isPrivate) {
  failures.push(`${repo} must be public before outreach.`);
}
if (repoState.description !== expectedDescription) {
  failures.push(`GitHub description is not the launch description.\n  expected: ${expectedDescription}\n  actual:   ${repoState.description}`);
}
if (repoState.homepageUrl !== "https://www.npmjs.com/package/hermes-live-voice") {
  failures.push(`GitHub homepage should point at the npm install surface, got: ${repoState.homepageUrl || "empty"}`);
}
if (!repoState.hasIssuesEnabled) {
  failures.push("GitHub Issues must be enabled before launch so provider receipts and first-contributor issues can be opened.");
}
if (!repoState.hasDiscussionsEnabled) {
  failures.push("GitHub Discussions must be enabled before launch so Hermes builders can ask setup and workflow questions.");
}
for (const topic of requiredTopics) {
  if (!topicNames.has(topic)) {
    failures.push(`GitHub topic is missing: ${topic}`);
  }
}
for (const topic of forbiddenTopics) {
  if (topicNames.has(topic)) {
    failures.push(`GitHub topic should be removed before launch: ${topic}`);
  }
}

if (latestRelease !== targetTag) {
  const message = `Latest GitHub release is ${latestRelease || "absent"}, expected ${targetTag}.`;
  if (allowPendingRelease) warnings.push(message);
  else failures.push(message);
}
if (npmVersion !== targetVersion) {
  const message = `npm latest is ${npmVersion}, expected ${targetVersion}.`;
  if (allowPendingRelease) warnings.push(message);
  else failures.push(message);
}

for (const context of requiredChecks) {
  if (!requiredContexts.has(context)) {
    failures.push(`main branch protection does not require check: ${context}`);
  }
}

console.log(`Public launch audit for ${repo}`);
console.log(`- target: ${packageJson.name}@${targetVersion}`);
console.log(`- GitHub: ${repoState.url}`);
console.log(`- stars: ${repoState.stargazerCount}`);
console.log(`- latest release: ${latestRelease || "absent"}`);
console.log(`- npm latest: ${npmVersion}`);
console.log(`- homepage: ${repoState.homepageUrl || "empty"}`);
console.log(`- issues: ${repoState.hasIssuesEnabled ? "enabled" : "disabled"}`);
console.log(`- discussions: ${repoState.hasDiscussionsEnabled ? "enabled" : "disabled"}`);
console.log(`- required checks: ${Array.from(requiredContexts).sort().join(", ") || "none"}`);

if (warnings.length > 0) {
  console.warn(`\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
}
if (failures.length > 0) {
  console.error(`\nPublic launch audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Public launch audit ok: release, metadata, topics, intake surfaces, and required checks are aligned.");

function ghJson(args) {
  return JSON.parse(exec("gh", args));
}

function npmJson(args) {
  return JSON.parse(exec("npm", args));
}

function exec(command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    const detail = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
}

function collectRequiredContexts(protection) {
  const contexts = new Set();
  for (const context of protection.required_status_checks?.contexts ?? []) {
    contexts.add(context);
  }
  for (const check of protection.required_status_checks?.checks ?? []) {
    if (check.context) {
      contexts.add(check.context);
    }
  }
  return contexts;
}
