import { access, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const markdownFiles = await collectMarkdownFiles(root);
const failures = [];

for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  const targets = [
    ...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g),
    ...source.matchAll(/(?:href|src)=["']([^"']+)["']/g),
  ].map((match) => match[1]?.trim()).filter(Boolean);

  for (const rawTarget of targets) {
    const target = rawTarget.replace(/^<|>$/g, "").split("#", 1)[0]?.split("?", 1)[0];
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
      continue;
    }
    const localPath = resolve(dirname(file), decodeURIComponent(target));
    try {
      await access(localPath);
    } catch {
      failures.push(`${file.slice(root.length + 1)} -> ${rawTarget}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Broken local documentation links:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${markdownFiles.length} Markdown files for broken local links.`);
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
