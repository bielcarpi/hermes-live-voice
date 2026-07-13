#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const mappings = [
  ["clients/browser/hermes-live-client.js", "plugins/hermes-live/dashboard/dist/hermes-live-client.js"],
  ["clients/browser/mic-worklet.js", "plugins/hermes-live/dashboard/dist/mic-worklet.js"],
];

let stale = false;
for (const [sourceRelative, targetRelative] of mappings) {
  const source = resolve(root, sourceRelative);
  const target = resolve(root, targetRelative);
  const expected = await readFile(source);
  const actual = await readFile(target).catch(() => undefined);

  if (actual?.equals(expected)) {
    continue;
  }

  stale = true;
  if (checkOnly) {
    console.error(`Dashboard asset is missing or stale: ${targetRelative}`);
    continue;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, expected);
  console.log(`Synced ${sourceRelative} -> ${targetRelative}`);
}

if (checkOnly && stale) {
  console.error("Run `npm run sync:dashboard-assets` and commit the generated copies.");
  process.exitCode = 1;
} else if (checkOnly) {
  console.log("Dashboard assets match their canonical browser client sources.");
}
