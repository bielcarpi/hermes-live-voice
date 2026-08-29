#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");
const workflowExtensions = new Set([".yml", ".yaml"]);
const fullCommitSha = /^[0-9a-f]{40}$/iu;
const failures = [];
const checked = [];

for (const fileName of readdirSync(workflowsDir).sort()) {
  if (!workflowExtensions.has(extname(fileName))) {
    continue;
  }
  const filePath = join(workflowsDir, fileName);
  const relativePath = relative(root, filePath);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);

  lines.forEach((line, index) => {
    const match = /\buses:\s*["']?([^"'\s#]+)["']?/u.exec(line);
    if (!match) {
      return;
    }

    const spec = match[1];
    if (spec.startsWith("./") || spec.startsWith("docker://")) {
      return;
    }

    const atIndex = spec.lastIndexOf("@");
    if (atIndex === -1) {
      failures.push(`${relativePath}:${index + 1} action reference is missing an immutable ref: ${spec}`);
      return;
    }

    const action = spec.slice(0, atIndex);
    const ref = spec.slice(atIndex + 1);
    if (!action.includes("/")) {
      failures.push(`${relativePath}:${index + 1} action reference is not owner/repo scoped: ${spec}`);
      return;
    }
    if (!fullCommitSha.test(ref)) {
      failures.push(`${relativePath}:${index + 1} action reference must use a 40-character commit SHA: ${spec}`);
      return;
    }
    checked.push(`${relativePath}:${index + 1} ${spec}`);
  });
}

if (failures.length > 0) {
  console.error("Workflow pin smoke failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Workflow pin smoke ok: ${checked.length} external action references use full commit SHAs.`);
