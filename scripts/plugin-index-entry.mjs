#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`plugin-index-entry: ${message}\n`);
  process.exit(1);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = readFileSync(resolve(root, "plugins/hermes-live/plugin.yaml"), "utf8");

const explicitRef = process.env.PLUGIN_INDEX_REF;
const ref = explicitRef ?? git(["rev-parse", "HEAD"]);
const addedAt = process.env.PLUGIN_INDEX_ADDED_AT ?? new Date().toISOString().slice(0, 10);
const checkOnly = process.argv.includes("--check");

assert(packageJson.name === "hermes-live-voice", "package name changed; update plugin index generator");
assert(packageJson.description === scalar("description"), "package and plugin descriptions must match");
assert(scalar("name") === "hermes-live", "plugin manifest name must stay hermes-live");
assert(Number(scalar("api_version")) === 1, "plugin api_version must be 1");
assert(/^[0-9a-f]{40}$/u.test(ref), "PLUGIN_INDEX_REF must be a full 40-character commit SHA");
assert(/^\d{4}-\d{2}-\d{2}$/u.test(addedAt), "PLUGIN_INDEX_ADDED_AT must be YYYY-MM-DD");
if (!explicitRef && !checkOnly) {
  assert(
    git(["status", "--porcelain"]) === "",
    "working tree has uncommitted changes; commit first or set PLUGIN_INDEX_REF to the reviewed public commit",
  );
}

const entry = {
  name: "hermes-live",
  description: packageJson.description,
  author: "Biel Carpi and Hermes Live contributors",
  tags: [
    "voice",
    "realtime",
    "dashboard",
    "gateway",
    "background-tasks",
  ],
  repo: "bielcarpi/hermes-live-voice",
  subdir: "plugins/hermes-live",
  ref,
  homepage: "https://github.com/bielcarpi/hermes-live-voice",
  capabilities: [
    "tools",
    "dashboard",
  ],
  api_version: 1,
  added_at: addedAt,
};

if (checkOnly) {
  process.exit(0);
}

process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);

function scalar(name) {
  const pattern = new RegExp(`^${escapeRegExp(name)}:\\s*(.+?)\\s*$`, "mu");
  const match = pattern.exec(manifest);
  if (!match) throw new Error(`plugin.yaml is missing ${name}`);
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
