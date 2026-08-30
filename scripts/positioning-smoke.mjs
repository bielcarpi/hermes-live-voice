#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

const packageJson = JSON.parse(read("package.json"));
if (packageJson.description !== "Continuous realtime voice for Hermes Agent. Talk while Hermes runs background tasks.") {
  failures.push("package.json description must stay focused on the Hermes realtime voice workflow");
}

const weakKeywords = new Set(["nous-research", "ai-agents", "terminal"]);
for (const keyword of packageJson.keywords ?? []) {
  if (weakKeywords.has(keyword)) {
    failures.push(`package.json keyword is too broad or misleading for discovery: ${keyword}`);
  }
}

const requiredSnippets = [
  {
    file: "README.md",
    snippets: [
      "Hermes Live Voice is a self-hosted realtime voice gateway and Dashboard plugin for [Hermes Agent]",
      "Hermes remains the agent brain",
      "This is a community project, not an official NousResearch distribution.",
    ],
  },
  {
    file: "docs/architecture.md",
    snippets: [
      "It is an independent community integration, not a replacement for Hermes or an official NousResearch release.",
      "Hermes keeps its memory, tools, skills, MCP servers, and execution environment.",
    ],
  },
];

for (const requirement of requiredSnippets) {
  const source = read(requirement.file);
  const normalizedSource = normalizeWhitespace(source);
  for (const snippet of requirement.snippets) {
    if (!normalizedSource.includes(normalizeWhitespace(snippet))) {
      failures.push(`${requirement.file} is missing required positioning text: ${snippet}`);
    }
  }
}

const publicPositioningFiles = [
  "README.md",
  "package.json",
  "plugins/hermes-live/plugin.yaml",
  "plugins/hermes-live/README.md",
  "plugins/hermes-live/after-install.md",
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/ISSUE_TEMPLATE/provider_compatibility_report.md",
  "SUPPORT.md",
];

const forbiddenPublicClaims = [
  /\bofficial\s+Hermes\s+(?:voice\s+)?gateway\b/iu,
  /\bofficial\s+NousResearch\s+integration\b/iu,
  /\bofficially\s+recommended\b/iu,
  /\brecommended\s+realtime\s+voice\s+plugin\b/iu,
  /\bproduction[- ]ready\s+for\s+every\s+provider\b/iu,
];

for (const file of publicPositioningFiles) {
  const lines = read(file).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of forbiddenPublicClaims) {
      if (pattern.test(line)) {
        failures.push(`${file}:${index + 1} contains forbidden public positioning: ${line.trim()}`);
      }
    }
  });
}

const pluginManifest = read("plugins/hermes-live/plugin.yaml");
for (const expected of [
  "manifest_version: 2",
  "api_version: 1",
  "kind: standalone",
  "HERMES_LIVE_AUTH_TOKEN",
  "secret: true",
]) {
  if (!pluginManifest.includes(expected)) {
    failures.push(`plugins/hermes-live/plugin.yaml is missing ${expected}`);
  }
}

const socialPreview = readFileSync(resolve(root, "assets/social-preview.png"));
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (!socialPreview.subarray(0, pngSignature.length).equals(pngSignature)) {
  failures.push("assets/social-preview.png must be a PNG file");
} else {
  const width = socialPreview.readUInt32BE(16);
  const height = socialPreview.readUInt32BE(20);
  if (width !== 1280 || height !== 640) {
    failures.push(`assets/social-preview.png must be 1280x640, got ${width}x${height}`);
  }
}
if (socialPreview.byteLength >= 1_000_000) {
  failures.push("assets/social-preview.png must stay under GitHub's 1 MB limit");
}

if (failures.length > 0) {
  console.error(`Positioning smoke failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Positioning smoke ok: public claims, plugin metadata, and social preview verified.");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}
