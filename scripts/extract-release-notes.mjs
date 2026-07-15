#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function extractReleaseNotes(changelog, version) {
  if (typeof changelog !== "string") {
    throw new TypeError("Changelog content must be a string.");
  }
  if (typeof version !== "string" || version.length === 0 || /[\r\n]/.test(version)) {
    throw new Error("Release version must be a non-empty single-line string.");
  }

  const normalized = changelog.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^## ${escapedVersion}(?: - \\d{4}-\\d{2}-\\d{2})?$`);
  const matchingIndexes = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index])) {
      matchingIndexes.push(index);
    }
  }

  if (matchingIndexes.length === 0) {
    throw new Error(`CHANGELOG.md has no exact section for ${version}.`);
  }
  if (matchingIndexes.length > 1) {
    throw new Error(`CHANGELOG.md has multiple exact sections for ${version}.`);
  }

  const start = matchingIndexes[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }

  const sectionLines = lines.slice(start, end);
  while (sectionLines.length > 0 && sectionLines.at(-1).trim() === "") {
    sectionLines.pop();
  }

  const body = sectionLines.slice(1).join("\n").trim();
  if (body.length === 0) {
    throw new Error(`CHANGELOG.md section for ${version} is empty.`);
  }
  if (body.includes("<!--") || body.includes("-->")) {
    throw new Error(`CHANGELOG.md section for ${version} must not contain HTML comments.`);
  }

  return `${sectionLines.join("\n")}\n`;
}

function parseArguments(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Usage: extract-release-notes --version X.Y.Z --input CHANGELOG.md --output RELEASE_NOTES.md");
    }
    parsed[flag.slice(2)] = value;
  }
  if (!parsed.version || !parsed.input || !parsed.output) {
    throw new Error("Usage: extract-release-notes --version X.Y.Z --input CHANGELOG.md --output RELEASE_NOTES.md");
  }
  return parsed;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const notes = extractReleaseNotes(readFileSync(options.input, "utf8"), options.version);
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, notes, "utf8");
}
