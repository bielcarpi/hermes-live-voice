import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const workDir = mkdtempSync(join(tmpdir(), "hermes-live-package-smoke-"));
const cacheDir = join(workDir, "npm-cache");
const installDir = join(workDir, "install");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(installDir, { recursive: true });

try {
  const result = spawnSync(npm, ["pack", "--json", "--pack-destination", workDir], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDir, NPM_CONFIG_CACHE: cacheDir },
  });

  if (result.status !== 0) {
    throw new Error(`npm pack failed with status ${result.status ?? "null"}\n${result.stdout}\n${result.stderr}`);
  }

  const pack = parsePackJson(result.stdout);
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const cliSource = readFileSync("dist/cli.js", "utf8");
  const files = new Set(pack.files.map((file) => file.path));

  if (packageJson.bin?.["hermes-live"] !== "dist/cli.js") {
    throw new Error('Package bin must expose "hermes-live" at dist/cli.js.');
  }
  if (
    packageLock.name !== packageJson.name ||
    packageLock.version !== packageJson.version ||
    packageLock.packages?.[""]?.name !== packageJson.name ||
    packageLock.packages?.[""]?.version !== packageJson.version ||
    packageLock.packages?.[""]?.bin?.["hermes-live"] !== packageJson.bin["hermes-live"]
  ) {
    throw new Error("package-lock.json root package metadata does not match package.json.");
  }
  if (!cliSource.startsWith("#!/usr/bin/env node\n")) {
    throw new Error("dist/cli.js must keep its node shebang.");
  }

  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    ".env.example",
    "assets/architecture.svg",
    "assets/banner.svg",
    "dist/index.js",
    "dist/cli.js",
    "dist/cli/terminal-session.js",
    "dist/config.js",
    "dist/live-provider-smoke.js",
    "dist/adapters/inbound/http/server.js",
    "dist/adapters/inbound/http/static.js",
    "dist/adapters/inbound/http/websocket-client-connection.js",
    "dist/adapters/outbound/hermes/hermes-runs.client.js",
    "dist/adapters/outbound/hermes/sse.js",
    "dist/adapters/outbound/realtime/factory.js",
    "dist/adapters/outbound/realtime/gemini-live.adapter.js",
    "dist/adapters/outbound/realtime/mock-live.adapter.js",
    "dist/adapters/outbound/realtime/openai-realtime.adapter.js",
    "dist/adapters/outbound/task-store/file-task-store.js",
    "dist/application/live-gateway/live-gateway-session.js",
    "dist/application/live-gateway/client-capabilities.js",
    "dist/application/live-gateway/ports/client-connection.port.js",
    "dist/application/live-gateway/ports/hermes-runs.port.js",
    "dist/application/live-gateway/ports/realtime-model.port.js",
    "dist/application/live-gateway/ports/task-supervisor.port.js",
    "dist/application/live-gateway/task-public-projection.js",
    "dist/application/task-supervisor/ports/task-store.port.js",
    "dist/application/task-supervisor/task-supervisor.js",
    "dist/domain/audio/pcm.js",
    "dist/domain/protocol/client-protocol.js",
    "dist/domain/protocol/server-protocol.js",
    "dist/domain/protocol/version.js",
    "dist/domain/tasks/task-transition.js",
    "dist/domain/tasks/task.js",
    "clients/browser/hermes-live-client.js",
    "clients/browser/hermes-live-client.d.ts",
    "clients/browser/mic-worklet.js",
    "apps/web-demo/index.html",
    "apps/web-demo/app.js",
    "docs/background-tasks.md",
    "docs/client-protocol.md",
    "docs/live-provider-testing.md",
    "examples/docker-compose.yml",
    "plugins/hermes-live/plugin.yaml",
    "plugins/hermes-live/__init__.py",
    "plugins/hermes-live/schemas.py",
    "plugins/hermes-live/tools.py",
    "plugins/hermes-live/after-install.md",
    "plugins/hermes-live/dashboard/manifest.json",
    "plugins/hermes-live/dashboard/plugin_api.py",
    "plugins/hermes-live/dashboard/dist/index.js",
    "plugins/hermes-live/dashboard/dist/style.css",
    "plugins/hermes-live/dashboard/dist/hermes-live-client.js",
    "plugins/hermes-live/dashboard/dist/mic-worklet.js",
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
        file.startsWith("scripts/") ||
        file.startsWith("test/") ||
        (/(^|\/)\.[^/]+/.test(file) && file !== ".env.example") ||
        / \d+\.[^/]+$/.test(file) ||
        file.includes("__pycache__") ||
        file.endsWith(".pyc") ||
        file === ".env" ||
        file.endsWith(".tgz"),
    );

  if (forbidden.length > 0) {
    throw new Error(`Package includes forbidden files:\n${forbidden.join("\n")}`);
  }

  const staleCompiledPaths = pack.files
    .map((file) => file.path)
    .filter(
      (file) =>
        file.startsWith("dist/audio/") ||
        file.startsWith("dist/gemini/") ||
        file.startsWith("dist/hermes/") ||
        file.startsWith("dist/openai/") ||
        file.startsWith("dist/realtime/") ||
        file.startsWith("dist/server/") ||
        file.startsWith("dist/session/"),
    );

  if (staleCompiledPaths.length > 0) {
    throw new Error(`Package includes pre-migration compiled paths:\n${staleCompiledPaths.join("\n")}`);
  }

  const tarball = join(workDir, pack.filename);
  const install = spawnSync(npm, ["install", "--prefix", installDir, "--omit=dev", tarball], {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cacheDir, NPM_CONFIG_CACHE: cacheDir },
  });
  if (install.status !== 0) {
    throw new Error(`npm install of packed tarball failed with status ${install.status ?? "null"}\n${install.stdout}\n${install.stderr}`);
  }

  const bin = process.platform === "win32"
    ? join(installDir, "node_modules", ".bin", "hermes-live.cmd")
    : join(installDir, "node_modules", ".bin", "hermes-live");
  const help = spawnSync(bin, ["--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HERMES_LIVE_PROVIDER: "mock",
    },
  });
  if (
    help.status !== 0 ||
    !help.stdout.includes("hermes-live") ||
    !help.stdout.includes("terminal") ||
    !help.stdout.includes("provider-smoke") ||
    !help.stdout.includes("HERMES_LIVE_PROVIDER")
  ) {
    throw new Error(`Installed CLI help failed with status ${help.status ?? "null"}\n${help.stdout}\n${help.stderr}`);
  }

  const version = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== packageJson.version) {
    throw new Error(
      `Installed CLI version failed with status ${version.status ?? "null"}; expected ${packageJson.version}.\n${version.stdout}\n${version.stderr}`,
    );
  }

  const hermesPluginsDir = join(workDir, "hermes-plugins");
  mkdirSync(hermesPluginsDir, { recursive: true });
  const pluginInstall = spawnSync(bin, ["plugin", "install", "--dir", hermesPluginsDir], {
    encoding: "utf8",
    env: { ...process.env, HERMES_LIVE_PROVIDER: "mock" },
  });
  if (pluginInstall.status !== 0) {
    throw new Error(`Installed CLI plugin install failed with status ${pluginInstall.status ?? "null"}\n${pluginInstall.stdout}\n${pluginInstall.stderr}`);
  }
  const pluginInstallReport = JSON.parse(pluginInstall.stdout);
  if (!pluginInstallReport.installed || !pluginInstallReport.manifestFound) {
    throw new Error(`Installed CLI plugin install returned an invalid report:\n${pluginInstall.stdout}`);
  }
  if (!existsSync(join(hermesPluginsDir, "hermes-live", "plugin.yaml"))) {
    throw new Error("Installed CLI plugin install did not write plugin.yaml.");
  }
  for (const relative of [
    "dashboard/manifest.json",
    "dashboard/plugin_api.py",
    "dashboard/dist/index.js",
    "dashboard/dist/style.css",
  ]) {
    if (!existsSync(join(hermesPluginsDir, "hermes-live", relative))) {
      throw new Error(`Installed CLI plugin install did not write ${relative}.`);
    }
  }

  const installedPluginYaml = readFileSync(join(hermesPluginsDir, "hermes-live", "plugin.yaml"), "utf8");
  const installedPluginVersion = /^version:[ \t]*([^\s#]+)/mu.exec(installedPluginYaml)?.[1];
  if (installedPluginVersion !== packageJson.version) {
    throw new Error(
      `Installed plugin version mismatch: expected ${packageJson.version}, got ${installedPluginVersion ?? "missing"}.`,
    );
  }
  const installedDashboardManifest = JSON.parse(
    readFileSync(join(hermesPluginsDir, "hermes-live", "dashboard", "manifest.json"), "utf8"),
  );
  if (installedDashboardManifest.version !== packageJson.version) {
    throw new Error(
      `Installed Dashboard plugin version mismatch: expected ${packageJson.version}, got ${String(installedDashboardManifest.version)}.`,
    );
  }

  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const m = await import(${JSON.stringify(packageJson.name)});`,
        "const required = ['startServer','loadConfig','assertRuntimeConfig','assertHermesApiConfig','assertRealtimeProviderConfig','assertGatewayExposureConfig','realtimeProviderConfigured','buildReadinessReport','runLiveProviderSmoke','HermesClient','OpenAIRealtimeAdapter','GeminiLiveAdapter','parseClientMessage'];",
        "const missing = required.filter((name) => typeof m[name] !== 'function');",
        "if (missing.length) { console.error('Missing exports: ' + missing.join(',')); process.exit(1); }",
      ].join(" "),
    ],
    {
      cwd: installDir,
      encoding: "utf8",
    },
  );
  if (imported.status !== 0) {
    throw new Error(`Installed package import failed with status ${imported.status ?? "null"}\n${imported.stdout}\n${imported.stderr}`);
  }

  const browserImported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      [
        `const m = await import(${JSON.stringify(`${packageJson.name}/browser`)});`,
        "const required = ['HermesLiveClient','HermesLiveAudio','buildGatewayWebSocketUrl','validateServerMessage'];",
        "const missing = required.filter((name) => typeof m[name] !== 'function');",
        "if (missing.length) { console.error('Missing browser exports: ' + missing.join(',')); process.exit(1); }",
        "if (Object.keys(m).some((name) => name.includes('OpenAI') || name.includes('Gemini'))) process.exit(2);",
      ].join(" "),
    ],
    { cwd: installDir, encoding: "utf8" },
  );
  if (browserImported.status !== 0) {
    throw new Error(
      `Installed browser import failed with status ${browserImported.status ?? "null"}\n${browserImported.stdout}\n${browserImported.stderr}`,
    );
  }

  console.log(`Package smoke ok: ${pack.entryCount} files, ${pack.filename}, install and CLI verified`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
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
