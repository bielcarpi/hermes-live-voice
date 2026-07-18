import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { writeManagedConfig } from "../src/cli/managed-config.js";
import { installHermesPlugin } from "../src/cli/plugin-installer.js";
import type { CommandRunner } from "../src/cli/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("doctor", () => {
  it("reports a healthy managed installation without leaking credentials", async () => {
    const home = await temporaryHome();
    const pluginsDir = join(home, ".hermes", "plugins");
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/capabilities") {
        response.end(JSON.stringify({
          features: {
            run_submission: true,
            run_status: true,
            run_events_sse: true,
            run_stop: true,
            run_approval_response: true,
          },
        }));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server.");
    await writeManagedConfig({
      HERMES_BASE_URL: `http://127.0.0.1:${address.port}`,
      HERMES_AGENT_API_SERVER_KEY: "doctor-hermes-secret",
      HERMES_LIVE_PROVIDER: "mock",
    }, { home });
    await installHermesPlugin({ dir: pluginsDir, force: true });
    const runner: CommandRunner = async (command, args) => ({
      command,
      args,
      code: 0,
      stdout: args.includes("is-active") ? "active\n" : "",
      stderr: "",
      timedOut: false,
    });
    try {
      const report = await runDoctor({
        json: true,
        providerSmoke: false,
        pluginsDir,
      }, {
        home,
        platform: "linux",
        env: {},
        runner,
        findCommand: async () => "/usr/local/bin/hermes",
        fetch: async () => new Response(JSON.stringify({ status: "ready", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });

      expect(report.ok).toBe(true);
      expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
        "node", "config", "plugin", "hermes-cli", "hermes-api", "provider-config", "service", "gateway",
      ]));
      expect(JSON.stringify(report)).not.toContain("doctor-hermes-secret");
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("turns missing activation pieces into exact remediation", async () => {
    const home = await temporaryHome();
    const report = await runDoctor({ json: true, providerSmoke: false }, {
      home,
      platform: "win32",
      env: { HERMES_LIVE_PROVIDER: "mock" },
      nodeVersion: "18.20.0",
      findCommand: async () => undefined,
      fetch: async () => { throw new Error("offline"); },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "node")).toMatchObject({ status: "fail" });
    expect(report.checks.find((check) => check.id === "config")).toMatchObject({ status: "warn", fix: "Run `hermes-live setup`." });
    expect(report.checks.find((check) => check.id === "plugin")).toMatchObject({ status: "fail" });
    expect(report.checks.find((check) => check.id === "service")).toMatchObject({ status: "warn" });
  });
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-doctor-"));
  temporaryDirectories.push(path);
  return path;
}
