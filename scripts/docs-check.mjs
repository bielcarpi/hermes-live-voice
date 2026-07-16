import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const markdownFiles = await collectMarkdownFiles(root);
const anchorCache = new Map();
const failures = [];

for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  const linkSource = removeFencedCode(source);
  const targets = [
    ...linkSource.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g),
    ...linkSource.matchAll(/(?:href|src)=["']([^"']+)["']/g),
  ].map((match) => match[1]?.trim()).filter(Boolean);

  for (const rawTarget of targets) {
    const target = rawTarget.replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;

    const hashIndex = target.indexOf("#");
    const pathWithQuery = hashIndex === -1 ? target : target.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? "" : decode(target.slice(hashIndex + 1));
    const localTarget = pathWithQuery.split("?", 1)[0];
    const localPath = localTarget
      ? resolve(dirname(file), decode(localTarget))
      : file;

    try {
      await access(localPath);
    } catch {
      failures.push(`${relative(file)} -> ${rawTarget} (missing file)`);
      continue;
    }

    if (!fragment || extname(localPath).toLowerCase() !== ".md") continue;
    const anchors = await markdownAnchors(localPath);
    if (!anchors.has(fragment.toLowerCase())) {
      failures.push(`${relative(file)} -> ${rawTarget} (missing anchor)`);
    }
  }
}

const protocolRevisionContract = [
  {
    file: "docs/client-protocol.md",
    required: [
      "two independent per-task revision channels",
      "complementary projections, not duplicates",
      "exact equal-sequence replay as idempotent",
      "same channel is a protocol error and must fail closed",
    ],
  },
  {
    file: "docs/background-tasks.md",
    required: [
      "two independent revisions",
      "Lifecycle and notification messages can share one sequence and arrive in either order",
      "conflicting content at the same channel sequence must fail closed",
    ],
  },
  {
    file: "docs/ui-integration.md",
    required: [
      "keeps lifecycle and notification revisions separate",
      "may share one sequence and arrive in either order; both are applied",
      "conflicting equal-sequence repeats fail closed",
    ],
  },
];

for (const contract of protocolRevisionContract) {
  const source = await readFile(resolve(root, contract.file), "utf8");
  for (const snippet of contract.required) {
    if (!source.includes(snippet)) {
      failures.push(`${contract.file} (missing protocol ordering contract: ${snippet})`);
    }
  }
}

const obsoleteProtocolClaims = [
  "Clients deduplicate and order lifecycle updates by `(taskId, sequence)`.",
  "The SDK deduplicates by `(taskId, sequence)`",
];
for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  for (const claim of obsoleteProtocolClaims) {
    if (source.includes(claim)) {
      failures.push(`${relative(file)} (obsolete single-channel ordering claim: ${claim})`);
    }
  }
}

const anchorSanitizationCases = [
  { heading: "<span>Release notes</span>", expected: "release-notes" },
  { heading: "<<script>alert(1)</script> Release", expected: "alert1-release" },
  { heading: "2 < 3", expected: "2-3" },
];
for (const testCase of anchorSanitizationCases) {
  const actual = githubAnchor(testCase.heading);
  if (actual !== testCase.expected) {
    failures.push(`anchor sanitization mismatch: expected ${testCase.expected}, received ${actual}`);
  }
}

if (failures.length > 0) {
  console.error("Documentation checks failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${markdownFiles.length} Markdown files for links, anchors, and the protocol ordering contract.`);
}

async function markdownAnchors(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;

  const source = await readFile(file, "utf8");
  const anchors = new Set();
  const counts = new Map();
  let fence = "";

  for (const line of source.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = "";
      continue;
    }
    if (fence) continue;

    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const base = githubAnchor(heading[1]);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }

    for (const match of line.matchAll(/(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(decode(match[1]).toLowerCase());
    }
  }

  anchorCache.set(file, anchors);
  return anchors;
}

function githubAnchor(heading) {
  return stripHtmlTags(heading)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function stripHtmlTags(value) {
  let output = "";
  let insideTag = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!insideTag && character === "<" && /[A-Za-z!/?]/u.test(value[index + 1] ?? "")) {
      insideTag = true;
      continue;
    }
    if (insideTag) {
      if (character === ">") insideTag = false;
      continue;
    }
    output += character;
  }
  return output;
}

function removeFencedCode(source) {
  let fence = "";
  return source.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(```+|~~~+)/);
    if (match) {
      if (!fence) fence = match[1][0];
      else if (fence === match[1][0]) fence = "";
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function relative(file) {
  return file.slice(root.length + 1);
}

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectMarkdownFiles(resolve(directory, entry.name))));
      }
    } else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      files.push(resolve(directory, entry.name));
    }
  }
  return files;
}
