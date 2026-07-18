import { createServer } from "node:http";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readManagedConfig } from "../src/cli/managed-config.js";
import { parseSetupOptions, runSetup } from "../src/cli/setup.js";
import type { CommandResult, CommandRunner } from "../src/cli/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("setup", () => {
  it("parses non-secret activation options and rejects key flags", () => {
    expect(parseSetupOptions([
      "--provider", "mock",
      "--hermes-url=http://127.0.0.1:9999",
      "--no-service",
      "--non-interactive",
      "--json",
    ])).toMatchObject({
      provider: "mock",
      hermesUrl: "http://127.0.0.1:9999",
      service: false,
      nonInteractive: true,
      json: true,
    });
    expect(() => parseSetupOptions(["--openai-api-key", "secret"])).toThrow(/Unknown setup option/u);
  });

  it("activates a clean home using Hermes .env without exposing secrets", async () => {
    const home = await temporaryHome();
    const pluginsDir = join(home, ".hermes", "plugins");
    await mkdir(join(home, ".hermes"), { recursive: true, mode: 0o700 });
    await writeFile(join(home, ".hermes", ".env"), "API_SERVER_KEY=hermes-private\n", { mode: 0o600 });
    await chmod(join(home, ".hermes", ".env"), 0o600);
    const server = createServer((request, response) => {
      if (request.url === "/v1/capabilities") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          model: "hermes-agent",
          features: {
            run_submission: true,
            run_status: true,
            run_events_sse: true,
            run_stop: true,
            run_approval_response: true,
          },
        }));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const hermesCommand = join(home, "bin", "hermes");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      return commandResult(command, args);
    };

    try {
      const report = await runSetup({
        provider: "mock",
        hermesUrl: `http://127.0.0.1:${address.port}`,
        pluginsDir,
        hermesCommand,
        enablePlugin: true,
        service: false,
        nonInteractive: true,
        json: true,
      }, {
        home,
        env: { PATH: join(home, "bin") },
        runner,
      });

      expect(report.ok).toBe(true);
      expect(report.hermesCli).toMatchObject({ enabled: true, command: hermesCommand });
      expect(report.readiness.ok).toBe(true);
      expect(report.providerSession).toEqual({ checked: false, ok: true });
      expect(report.nextSteps).toContain("Start the gateway with `hermes-live serve`.");
      expect(calls).toContainEqual([hermesCommand, ["plugins", "enable", "hermes-live"]]);
      const managed = await readManagedConfig({ home });
      expect(managed.values).toMatchObject({
        HERMES_AGENT_API_SERVER_KEY: "hermes-private",
        HERMES_LIVE_PROVIDER: "mock",
      });
      expect(JSON.stringify(report)).not.toContain("hermes-private");
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("fails non-interactively before writing when required secrets are absent", async () => {
    const home = await temporaryHome();
    await expect(runSetup({
      provider: "openai",
      enablePlugin: false,
      service: false,
      nonInteractive: true,
      json: true,
    }, { home, env: {} })).rejects.toThrow(/Hermes API_SERVER_KEY is required/u);
    await expect(readManagedConfig({ home })).resolves.toMatchObject({ exists: false });
  });

  it.runIf(process.platform !== "win32")("refuses a shared Hermes environment file", async () => {
    const home = await temporaryHome();
    await mkdir(join(home, ".hermes"), { recursive: true });
    const path = join(home, ".hermes", ".env");
    await writeFile(path, "API_SERVER_KEY=private\n", { mode: 0o644 });
    await chmod(path, 0o644);

    await expect(runSetup({
      provider: "mock",
      enablePlugin: false,
      service: false,
      nonInteractive: true,
      json: true,
    }, { home, env: {} })).rejects.toThrow(/must not be readable or writable by other users/u);
  });

  it("installs a user service and waits for the gateway after preflight", async () => {
    const home = await temporaryHome();
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
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      return commandResult(command, args, command === "systemctl" && args.includes("is-active") ? "active\n" : "");
    };
    try {
      const report = await runSetup({
        provider: "mock",
        hermesUrl: `http://127.0.0.1:${address.port}`,
        enablePlugin: false,
        service: true,
        nonInteractive: true,
        json: true,
      }, {
        home,
        platform: "linux",
        env: { HERMES_AGENT_API_SERVER_KEY: "private" },
        runner,
        fetch: async () => new Response(JSON.stringify({ status: "ready", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });

      expect(report.ok).toBe(true);
      expect(report.service).toMatchObject({ platform: "systemd", installed: true, running: true });
      expect(report.gateway).toMatchObject({ checked: true, ready: true });
      expect(calls).toContainEqual(["systemctl", ["--user", "start", "dev.hermes-live-voice.gateway"]]);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("does not install a service when plugin enablement fails", async () => {
    const home = await temporaryHome();
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        features: {
          run_submission: true,
          run_status: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
        },
      }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      return { command, args, code: 1, stdout: "", stderr: "enable failed", timedOut: false };
    };
    try {
      const report = await runSetup({
        provider: "mock",
        hermesUrl: `http://127.0.0.1:${address.port}`,
        hermesCommand: process.execPath,
        enablePlugin: true,
        service: true,
        nonInteractive: true,
        json: true,
      }, {
        home,
        platform: "linux",
        env: { HERMES_AGENT_API_SERVER_KEY: "private" },
        runner,
      });

      expect(report.ok).toBe(false);
      expect(report.service).toMatchObject({ skipped: true });
      expect(calls.some(([command]) => command === "systemctl")).toBe(false);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});

function commandResult(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, code: 0, stdout, stderr: "", timedOut: false };
}

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-setup-"));
  temporaryDirectories.push(path);
  return path;
}
