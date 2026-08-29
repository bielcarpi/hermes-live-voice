#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const repo = process.env.HERMES_LIVE_PUBLIC_REPO ?? "bielcarpi/hermes-live-voice";
const upstreamRepo = process.env.HERMES_LIVE_UPSTREAM_REPO ?? "NousResearch/hermes-agent";
const canonicalIndexRepo = process.env.HERMES_LIVE_PLUGIN_INDEX_REPO ?? "NousResearch/hermes-plugin-index";
const temporaryIndexRepo = process.env.HERMES_LIVE_TEMP_PLUGIN_INDEX_REPO ?? "Revell-ai/hermes-plugin-index";
const reportOnly = process.argv.includes("--report-only");
const failures = [];
const warnings = [];

const requiredIssues = [
  {
    number: 77111,
    name: "realtime voice provider/session RFC",
    expectedState: "OPEN",
    minimumOutcome: "must remain active or have an accepted replacement before official wording",
  },
  {
    number: 64947,
    name: "conversational Runs authority RFC",
    expectedState: "OPEN",
    minimumOutcome: "must remain active or have an accepted replacement before official wording",
  },
  {
    number: 87565,
    name: "canonical Hermes plugin index gap",
    expectedState: "OPEN",
    minimumOutcome: "must be resolved or replaced by a maintainer-accepted index before bare-name install claims",
  },
];

const communityVoicePr = {
  number: 97325,
  name: "hermes-talk community realtime voice docs PR",
};

const publicRepo = ghJson(["repo", "view", repo, "--json", "isPrivate,latestRelease,stargazerCount,url"]);
if (publicRepo.isPrivate) {
  failures.push(`${repo} must be public before upstream maintainers can review it as ecosystem evidence.`);
}
if (publicRepo.latestRelease?.tagName !== `v${packageJson.version}`) {
  warnings.push(`public latest release is ${publicRepo.latestRelease?.tagName ?? "absent"}, expected v${packageJson.version}.`);
}

const upstream = ghJson(["repo", "view", upstreamRepo, "--json", "isPrivate,url,pushedAt,latestRelease"]);
if (upstream.isPrivate) {
  failures.push(`${upstreamRepo} is not publicly readable through the active gh token.`);
}

const issueReports = [];
for (const issue of requiredIssues) {
  const state = ghJson([
    "issue",
    "view",
    String(issue.number),
    "--repo",
    upstreamRepo,
    "--json",
    "number,title,state,updatedAt,url,labels,comments",
  ]);
  issueReports.push({ ...issue, ...state });
  if (state.state !== issue.expectedState) {
    warnings.push(`${issue.name} #${issue.number} is ${state.state}; ${issue.minimumOutcome}.`);
  }
}

const voiceDocsPr = ghJson([
  "pr",
  "view",
  String(communityVoicePr.number),
  "--repo",
  upstreamRepo,
  "--json",
  "number,title,state,isDraft,mergeable,updatedAt,url,statusCheckRollup,comments",
]);
if (voiceDocsPr.state === "OPEN") {
  warnings.push(`${communityVoicePr.name} #${communityVoicePr.number} is still open; do not post competing docs comments unless maintainers ask.`);
}

const canonicalIndex = repoExists(canonicalIndexRepo);
const temporaryIndex = repoExists(temporaryIndexRepo);
if (!canonicalIndex.exists && !temporaryIndex.exists) {
  failures.push("No canonical or temporary Hermes plugin index repository is reachable; bare-name plugin discovery is not actionable yet.");
} else if (!canonicalIndex.exists) {
  warnings.push(`${canonicalIndexRepo} is not reachable; use ${temporaryIndexRepo} only if maintainers still accept it.`);
}

const officialAcceptance = hasMaintainerAcceptance(issueReports) || hasMaintainerAcceptance([voiceDocsPr]);
if (!officialAcceptance) {
  failures.push("No explicit upstream maintainer acceptance signal found in labels or maintainer/collaborator comments on the tracked realtime/Runs/plugin-index threads. Keep wording as community, not official.");
}

console.log("Upstream readiness audit");
console.log(`- package: ${packageJson.name}@${packageJson.version}`);
console.log(`- project: ${publicRepo.url} (${publicRepo.stargazerCount} stars, latest ${publicRepo.latestRelease?.tagName ?? "absent"})`);
console.log(`- upstream: ${upstream.url} (latest ${upstream.latestRelease?.tagName ?? "absent"}, pushed ${upstream.pushedAt})`);
console.log(`- canonical plugin index: ${canonicalIndex.exists ? canonicalIndex.url : "not reachable"}`);
console.log(`- temporary plugin index: ${temporaryIndex.exists ? temporaryIndex.url : "not reachable"}`);
console.log("- tracked upstream items:");
for (const issue of issueReports) {
  const labels = (issue.labels ?? []).map((label) => label.name).join(", ") || "none";
  console.log(`  - #${issue.number} ${issue.state}: ${issue.title} (${labels})`);
}
console.log(`  - PR #${voiceDocsPr.number} ${voiceDocsPr.state}${voiceDocsPr.isDraft ? " draft" : ""}: ${voiceDocsPr.title}`);

if (warnings.length > 0) {
  console.warn(`\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`);
}
if (failures.length > 0) {
  console.error(`\nUpstream readiness audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  if (!reportOnly) process.exit(1);
} else {
  console.log("\nUpstream readiness audit ok: maintainer acceptance and plugin discovery prerequisites are aligned.");
}

function ghJson(args) {
  return JSON.parse(exec("gh", args));
}

function repoExists(ownerRepo) {
  try {
    const repoState = ghJson(["repo", "view", ownerRepo, "--json", "url,isPrivate"]);
    return { exists: !repoState.isPrivate, url: repoState.url };
  } catch {
    return { exists: false, url: "" };
  }
}

function hasMaintainerAcceptance(items) {
  const maintainerAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
  return items.some((item) => {
    const title = item.title ?? "";
    const labels = (item.labels ?? []).map((label) => label.name).join(" ");
    const state = item.state ?? "";
    if (hasAcceptanceSignal(`${title} ${labels} ${state}`)) return true;
    return (item.comments ?? []).some((comment) => (
      maintainerAssociations.has(comment.authorAssociation)
      && hasAcceptanceSignal(comment.body ?? "")
    ));
  });
}

function hasAcceptanceSignal(value) {
  const text = value.toLowerCase().replace(/\s+/gu, " ");
  const negative = [
    /\b(?:do not|don't|not|no|without|unless|before).{0,60}\b(?:accept|accepted|approve|approved|official|merge|merged|ship|shipped|list|listed)\b/u,
    /\b(?:accept|accepted|approve|approved|official|merge|merged|ship|shipped|list|listed)\b.{0,60}\b(?:not|no|false|blocked|rejected)\b/u,
  ];
  if (negative.some((pattern) => pattern.test(text))) return false;
  return [
    /\baccepted\b/u,
    /\bapproved\b/u,
    /\bmerged\b/u,
    /\bshipped\b/u,
    /\bofficial(?:ly)?\s+(?:accepted|approved|documented|listed)\b/u,
    /\bdocumented external realtime voice gateway\b/u,
    /\blist(?:ed)? as a community implementation\b/u,
  ].some((pattern) => pattern.test(text));
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
