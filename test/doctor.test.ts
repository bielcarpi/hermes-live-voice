import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseManagedLocalMemory, runDoctor } from "../src/cli/doctor.js";
import { writeManagedConfig } from "../src/cli/managed-config.js";
import { installHermesPlugin } from "../src/cli/plugin-installer.js";
import type { CommandRunner } from "../src/cli/process.js";
import { LOCAL_VOICE_SERVICE_LABEL, SERVICE_LABEL } from "../src/cli/service-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("doctor", () => {
  it("distinguishes unsupported memory from recoverable host pressure", () => {
    expect(diagnoseManagedLocalMemory(8 * 1024 ** 3)).toMatchObject({
      id: "local-memory",
      status: "fail",
      detail: expect.stringContaining("at least 12 GB"),
    });
    expect(diagnoseManagedLocalMemory(14 * 1024 ** 3)).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("16 GB or more"),
    });
    expect(diagnoseManagedLocalMemory(
      16 * 1024 ** 3,
      "System-wide memory free percentage: 37%",
      "total = 11264.00M used = 10190.69M free = 1073.31M",
    )).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("10.0 GB swap used"),
      fix: expect.stringContaining("local restart"),
    });
    expect(diagnoseManagedLocalMemory(
      32 * 1024 ** 3,
      "System-wide memory free percentage: 42%",
      "total = 2048.00M used = 256.00M free = 1792.00M",
    )).toMatchObject({ status: "pass" });
  });

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
            ...sessionFeatures(),
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
      stdout: args.includes("--version")
        ? "Hermes Agent v0.20.0 (2026.8.3)\n"
        : args.includes("is-active") ? "active\n" : "",
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
        fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });

      expect(report.ok).toBe(true);
      expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
        "node", "config", "plugin", "hermes-cli", "hermes-version", "hermes-api", "provider-config", "service", "gateway",
      ]));
      expect(report.checks.find((check) => check.id === "hermes-version")).toMatchObject({ status: "pass" });
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

  it("explains how to recover when another service owns the gateway port", async () => {
    const home = await temporaryHome();
    const report = await runDoctor({ json: true, providerSmoke: false }, {
      home,
      platform: "win32",
      env: { HERMES_LIVE_PROVIDER: "mock" },
      findCommand: async () => undefined,
      fetch: async (url) => String(url).endsWith("/health")
        ? new Response(JSON.stringify({ status: "ok", service: "codex-live-voice" }), {
            headers: { "content-type": "application/json" },
          })
        : new Response(JSON.stringify({ status: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
    });

    expect(report.checks.find((check) => check.id === "gateway")).toMatchObject({
      status: "fail",
      detail: "The configured port belongs to another service, not Hermes Live Voice.",
      fix: "Run `hermes-live setup` so it can select and share a free local port.",
    });
  });

  it("checks the managed local launcher and service on Apple Silicon", async () => {
    const home = await temporaryHome();
    const pluginsDir = join(home, ".hermes", "plugins");
    const launchAgents = join(home, "Library", "LaunchAgents");
    await mkdir(launchAgents, { recursive: true });
    await writeFile(join(launchAgents, `${SERVICE_LABEL}.plist`), "gateway");
    await writeFile(join(launchAgents, `${LOCAL_VOICE_SERVICE_LABEL}.plist`), "local voice");
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
            ...sessionFeatures(),
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
      HERMES_LIVE_PROVIDER: "local",
    }, { home });
    await installHermesPlugin({ dir: pluginsDir, force: true });
    const runner: CommandRunner = async (command, args) => ({
      command,
      args,
      code: 0,
      stdout: command === "launchctl" && args[0] === "print" ? "state = running\n" : "",
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
        platform: "darwin",
        arch: "arm64",
        totalMemoryBytes: 16 * 1024 ** 3,
        uid: 501,
        env: {},
        runner,
        findCommand: async (name) => name === "uv" ? "/opt/homebrew/bin/uv" : "/usr/local/bin/hermes",
        probeLocalEndpoint: async () => true,
        fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });

      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.id === "local-launcher")).toMatchObject({ status: "pass" });
      expect(report.checks.find((check) => check.id === "local-service")).toMatchObject({ status: "pass" });
      expect(report.localService).toMatchObject({ installed: true, running: true });

      const stillLoading = await runDoctor({ json: true, providerSmoke: false, pluginsDir }, {
        home,
        platform: "darwin",
        arch: "arm64",
        totalMemoryBytes: 16 * 1024 ** 3,
        uid: 501,
        env: {},
        runner,
        findCommand: async (name) => name === "uv" ? "/opt/homebrew/bin/uv" : "/usr/local/bin/hermes",
        probeLocalEndpoint: async () => false,
        fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });
      expect(stillLoading.ok).toBe(false);
      expect(stillLoading.checks.find((check) => check.id === "local-service")).toMatchObject({
        status: "fail",
        detail: expect.stringContaining("not listening yet"),
      });
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-doctor-"));
  temporaryDirectories.push(path);
  return path;
}

function sessionFeatures(): Record<string, true> {
  return {
    session_resources: true,
    session_chat: true,
    session_chat_streaming: true,
    model_options: true,
    session_model_lock: true,
  };
}
