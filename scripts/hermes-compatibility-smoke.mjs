#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const configuredImage = process.env.HERMES_COMPATIBILITY_IMAGE;
const image = configuredImage
  ?? "nousresearch/hermes-agent:v2026.8.3@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e";
const expectedVersion = process.env.HERMES_COMPATIBILITY_EXPECTED_VERSION ?? "0.20.0";
const suffix = `${process.pid}-${Date.now()}`;
const container = `hermes-live-compat-${suffix}`;
const volume = `hermes-live-compat-${suffix}`;
const apiKey = "hermes-live-compatibility-test-key";
let containerStarted = false;

try {
  await docker(["version", "--format", "{{.Server.Version}}"]);
  if (configuredImage && !configuredImage.includes("@sha256:")) {
    await docker(["pull", configuredImage], { timeout: 600_000 });
  }
  await docker(["volume", "create", volume]);
  await docker([
    "run",
    "--detach",
    "--name", container,
    "--volume", `${volume}:/opt/data`,
    "--volume", `${resolve(root, "plugins/hermes-live")}:/repo-plugin:ro`,
    "--env", "API_SERVER_ENABLED=true",
    "--env", "API_SERVER_HOST=127.0.0.1",
    "--env", "API_SERVER_PORT=8642",
    "--env", `API_SERVER_KEY=${apiKey}`,
    image,
    "hermes", "gateway", "run", "--no-supervise",
  ]);
  containerStarted = true;

  const capabilities = await waitForCapabilities();
  assertCapabilities(capabilities);

  const versionOutput = await dockerExec(["hermes", "--version"]);
  const version = /\bHermes Agent v(\d+\.\d+\.\d+)\b/u.exec(versionOutput)?.[1];
  if (!version || (expectedVersion !== "*" && version !== expectedVersion)) {
    throw new Error(`Expected Hermes Agent v${expectedVersion}, received ${version ?? "unknown"}.`);
  }
  if (expectedVersion === "*" && compareVersions(version, "0.18.2") < 0) {
    throw new Error(`Hermes Agent v${version} is older than the supported minimum, v0.18.2.`);
  }

  await dockerExec(["mkdir", "-p", "/opt/data/plugins"]);
  await dockerExec(["cp", "-R", "/repo-plugin", "/opt/data/plugins/hermes-live"]);
  await dockerExec(["hermes", "plugins", "enable", "hermes-live"]);
  const pluginList = JSON.parse(await dockerExec(["hermes", "plugins", "list", "--json"]));
  const plugin = pluginList.find((entry) => entry?.name === "hermes-live");
  if (!plugin) throw new Error("Hermes did not discover the bundled plugin.");
  if (plugin.status !== "enabled") throw new Error(`Hermes reported plugin status ${String(plugin.status)}.`);
  if (plugin.version !== packageJson.version) {
    throw new Error(`Plugin v${String(plugin.version)} does not match package v${packageJson.version}.`);
  }
  const dashboardPlugins = JSON.parse(await dockerExec([
    "python", "-c",
    [
      "import json",
      "from hermes_cli.web_server import _discover_dashboard_plugins",
      "print(json.dumps(_discover_dashboard_plugins()))",
    ].join(";"),
  ]));
  const dashboardPlugin = dashboardPlugins.find((entry) => entry?.name === "hermes-live");
  if (!dashboardPlugin) throw new Error("Hermes Dashboard did not discover the bundled plugin.");
  if (dashboardPlugin.version !== packageJson.version) {
    throw new Error(`Dashboard plugin v${String(dashboardPlugin.version)} does not match package v${packageJson.version}.`);
  }
  if (dashboardPlugin.tab?.path !== "/live-voice" || dashboardPlugin.has_api !== true) {
    throw new Error("Hermes Dashboard rejected the Live Voice route or backend.");
  }

  console.log(
    `Hermes compatibility smoke ok: Agent v${version}, current capabilities, and agent/Dashboard plugin v${plugin.version}.`,
  );
} catch (error) {
  if (containerStarted) {
    const logs = await docker(["logs", "--tail", "160", container], { allowFailure: true });
    if (logs.trim()) process.stderr.write(`\nHermes container logs:\n${logs.trim()}\n`);
  }
  throw error;
} finally {
  await docker(["rm", "--force", container], { allowFailure: true });
  await docker(["volume", "rm", "--force", volume], { allowFailure: true });
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

async function waitForCapabilities() {
  const deadline = Date.now() + 90_000;
  let lastError = "Hermes API did not start.";
  while (Date.now() < deadline) {
    const result = await docker([
      "exec", container, "python", "-c",
      [
        "import urllib.request",
        `request=urllib.request.Request('http://127.0.0.1:8642/v1/capabilities',headers={'Authorization':'Bearer ${apiKey}'})`,
        "print(urllib.request.urlopen(request,timeout=3).read().decode())",
      ].join(";"),
    ], { allowFailure: true, result: true });
    if (result.code === 0) return JSON.parse(result.stdout);
    lastError = result.stderr.trim() || result.stdout.trim() || lastError;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error(`Hermes API readiness timed out: ${lastError}`);
}

function assertCapabilities(capabilities) {
  const requiredFeatures = [
    "run_submission",
    "run_status",
    "run_events_sse",
    "run_stop",
    "run_approval_response",
    "tool_progress_events",
    "approval_events",
    "session_resources",
    "model_options",
    "session_chat",
    "session_chat_streaming",
    "session_model_lock",
  ];
  const missing = requiredFeatures.filter((feature) => capabilities?.features?.[feature] !== true);
  if (missing.length > 0) throw new Error(`Hermes is missing required capabilities: ${missing.join(", ")}.`);
  if (capabilities?.endpoints?.runs?.path !== "/v1/runs") {
    throw new Error("Hermes did not advertise the expected run endpoint.");
  }
  if (capabilities?.endpoints?.session_chat?.path !== "/api/sessions/{session_id}/chat") {
    throw new Error("Hermes did not advertise the expected saved-chat endpoint.");
  }
}

async function dockerExec(args) {
  return await docker(["exec", container, ...args]);
}

async function docker(args, options = {}) {
  try {
    const result = await execFileAsync("docker", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
    });
    const normalized = { code: 0, stdout: result.stdout, stderr: result.stderr };
    return options.result ? normalized : `${result.stdout}${result.stderr}`;
  } catch (error) {
    const normalized = {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error.message ?? error),
    };
    if (options.allowFailure) return options.result ? normalized : `${normalized.stdout}${normalized.stderr}`;
    throw new Error(`docker ${args.join(" ")} failed: ${normalized.stderr.trim() || normalized.stdout.trim()}`);
  }
}
