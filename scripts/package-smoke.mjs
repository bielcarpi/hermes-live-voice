import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cacheDir = mkdtempSync(join(tmpdir(), "hermes-live-npm-cache-"));

try {
  const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDir, NPM_CONFIG_CACHE: cacheDir },
  });

  if (result.status !== 0) {
    throw new Error(`npm pack failed with status ${result.status ?? "null"}\n${result.stdout}\n${result.stderr}`);
  }

  const pack = parsePackJson(result.stdout);
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const cliSource = readFileSync("dist/cli.js", "utf8");
  const files = new Set(pack.files.map((file) => file.path));

  if (packageJson.bin?.["hermes-live"] !== "./dist/cli.js") {
    throw new Error('Package bin must expose "hermes-live" at ./dist/cli.js.');
  }
  if (!cliSource.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("dist/cli.js must keep its node shebang.");
  }

  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    ".env.example",
    "dist/index.js",
    "dist/cli.js",
    "dist/config.js",
    "dist/server/http.js",
    "dist/openai/realtime.js",
    "dist/gemini/live.js",
    "apps/web-demo/index.html",
    "apps/web-demo/app.js",
    "docs/client-protocol.md",
    "docs/live-provider-testing.md",
    "examples/docker-compose.yml",
    "plugins/hermes-live/plugin.yaml",
  ];

  const missing = required.filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`Package is missing required files:\n${missing.join("\n")}`);
  }

  const forbidden = pack.files
    .map((file) => file.path)
    .filter(
      (file) =>
        file.startsWith("node_modules/") ||
        file.startsWith("src/") ||
        file.startsWith("test/") ||
        file.includes("__pycache__") ||
        file.endsWith(".pyc") ||
        file === ".env" ||
        file.endsWith(".tgz"),
    );

  if (forbidden.length > 0) {
    throw new Error(`Package includes forbidden files:\n${forbidden.join("\n")}`);
  }

  console.log(`Package smoke ok: ${pack.entryCount} files, ${pack.filename}`);
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

function parsePackJson(stdout) {
  const start = stdout.lastIndexOf("\n[");
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Unexpected npm pack JSON output:\n${jsonText}`);
  }
  return parsed[0];
}
