#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const scripts = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

const failures = [];

for (const script of scripts) {
  const path = resolve(scriptsDir, script);
  try {
    execFileSync(process.execPath, ["--check", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    failures.push(`${script}${stderr || stdout ? `\n${stderr || stdout}` : ""}`);
  }
}

if (failures.length > 0) {
  console.error(`Script syntax smoke failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log(`Script syntax smoke ok: ${scripts.length} .mjs scripts parse.`);
