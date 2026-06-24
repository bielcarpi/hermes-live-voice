import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const result = spawnSync(process.execPath, ["dist/cli.js", "check"], {
  encoding: "utf8",
  env: {
    ...process.env,
    HERMES_BASE_URL: "http://127.0.0.1:9",
    HERMES_API_KEY: "",
    HERMES_LIVE_HOST: "127.0.0.1",
    HERMES_LIVE_PROVIDER: "openai",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
    GOOGLE_GENAI_USE_ENTERPRISE: "",
  },
});

if (result.error) {
  throw result.error;
}
if (result.status === 0) {
  throw new Error(`Expected hermes-live check to fail without required credentials.\n${result.stdout}\n${result.stderr}`);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  throw new Error(`Expected hermes-live check to print JSON, got:\n${result.stdout}\n${result.stderr}`, { cause: error });
}

assertEqual(report.ok, false, "report.ok");
assertEqual(report.gateway?.ok, true, "gateway.ok");
assertEqual(report.hermes?.ok, false, "hermes.ok");
assertIncludes(report.hermes?.error, "HERMES_API_KEY", "hermes.error");
assertEqual(report.realtime?.ok, false, "realtime.ok");
assertEqual(report.realtime?.configured, false, "realtime.configured");
assertEqual(report.realtime?.provider, "openai", "realtime.provider");
assertIncludes(report.realtime?.error, "OPENAI_API_KEY", "realtime.error");

console.log("CLI check smoke ok: missing Hermes/OpenAI credentials are reported without provider startup.");

const pluginDir = mkdtempSync(join(tmpdir(), "hermes-live-cli-plugin-"));
const invalidRuntimeEnv = {
  ...process.env,
  HERMES_BASE_URL: "not-a-url",
  HERMES_LIVE_PORT: "not-a-port",
  HERMES_LIVE_PROVIDER: "not-a-provider",
};
try {
  const install = spawnSync(process.execPath, ["dist/cli.js", "plugin", "install", "--dir", pluginDir], {
    encoding: "utf8",
    env: invalidRuntimeEnv,
  });
  if (install.status !== 0) {
    throw new Error(`Expected plugin install to succeed.\n${install.stdout}\n${install.stderr}`);
  }
  const installReport = JSON.parse(install.stdout);
  assertEqual(installReport.installed, true, "plugin.install.installed");
  assertEqual(installReport.manifestFound, true, "plugin.install.manifestFound");
  if (!existsSync(join(pluginDir, "hermes-live", "plugin.yaml"))) {
    throw new Error("Plugin install did not create plugin.yaml in the target directory.");
  }

  const status = spawnSync(process.execPath, ["dist/cli.js", "plugin", "status", "--dir", pluginDir], {
    encoding: "utf8",
    env: invalidRuntimeEnv,
  });
  if (status.status !== 0) {
    throw new Error(`Expected plugin status to succeed.\n${status.stdout}\n${status.stderr}`);
  }
  const statusReport = JSON.parse(status.stdout);
  assertEqual(statusReport.installed, true, "plugin.status.installed");
  assertEqual(statusReport.manifestFound, true, "plugin.status.manifestFound");

  const pluginPath = spawnSync(process.execPath, ["dist/cli.js", "plugin", "path"], {
    encoding: "utf8",
    env: invalidRuntimeEnv,
  });
  if (pluginPath.status !== 0 || !pluginPath.stdout.includes("plugins/hermes-live")) {
    throw new Error(`Expected plugin path to ignore invalid runtime env.\n${pluginPath.stdout}\n${pluginPath.stderr}`);
  }
} finally {
  rmSync(pluginDir, { recursive: true, force: true });
}

console.log("CLI plugin smoke ok: plugin install/status verified.");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function assertIncludes(actual, expected, label) {
  if (typeof actual !== "string" || !actual.includes(expected)) {
    throw new Error(`${label} mismatch. Expected it to include ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
