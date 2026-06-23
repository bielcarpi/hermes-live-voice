import { spawnSync } from "node:child_process";

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
