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
  {
    file: "docs/launch-kit.md",
    snippets: [
      "Keep outreach copy evidence-bounded and focused on Hermes builders.",
      "Avoid claiming official NousResearch status. This is a community MIT project.",
      "Generic launch and social communities that are not Hermes-specific.",
    ],
  },
  {
    file: "docs/maintainer-readiness-audit.md",
    snippets: [
      "not yet as an official Hermes integration",
      "Do not use stronger wording unless maintainers approve it in writing.",
      "Live-provider evidence is complete. | Not proven",
    ],
  },
  {
    file: "docs/upstream-integration-rfc.md",
    snippets: [
      "not a fork of Hermes Agent and not a provider SDK bundle inside Hermes core",
      "Do not use stronger wording such as \"official NousResearch distribution\"",
      "Avoid asking for official status in the first comment.",
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
  /\bSaturday\b/u,
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

if (failures.length > 0) {
  console.error(`Positioning smoke failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}

console.log("Positioning smoke ok: public claims, plugin metadata, and launch boundaries verified.");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, " ").trim();
}
