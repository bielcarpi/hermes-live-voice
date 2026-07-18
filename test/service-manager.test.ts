import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  SERVICE_LABEL,
  launchdServiceDefinition,
  resolveServicePlatform,
  runServiceAction,
  serviceStatus,
  systemdServiceDefinition,
} from "../src/cli/service-manager.js";
import type { CommandResult, CommandRunner } from "../src/cli/process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("service manager", () => {
  it("generates a secret-free launchd definition with absolute paths", () => {
    const definition = launchdServiceDefinition({
      home: "/Users/alice",
      nodePath: "/usr/local/bin/node",
      cliPath: "/usr/local/lib/hermes-live/dist/cli.js",
      configPath: "/Users/alice/.hermes/hermes-live/config.env",
    });

    expect(definition).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(definition).toContain("/usr/local/bin/node");
    expect(definition).toContain("HERMES_LIVE_CONFIG_FILE");
    expect(definition).toContain("<key>RunAtLoad</key>");
    expect(definition).not.toContain("API_KEY=");
  });

  it("escapes systemd paths and restarts only on failure", () => {
    const definition = systemdServiceDefinition({
      home: "/home/a user",
      nodePath: "/opt/node/bin/node",
      cliPath: "/home/a user/hermes-live/dist/cli.js",
      configPath: "/home/a user/.hermes/hermes-live/config.env",
    });

    expect(definition).toContain('ExecStart="/opt/node/bin/node" "/home/a user/hermes-live/dist/cli.js" serve');
    expect(definition).toContain('Environment="HERMES_LIVE_CONFIG_FILE=/home/a user/.hermes/hermes-live/config.env"');
    expect(definition).toContain("Restart=on-failure");
    expect(definition).not.toContain("API_KEY=");
  });

  it("maps native platforms and rejects unsupported service actions", async () => {
    expect(resolveServicePlatform("darwin")).toBe("launchd");
    expect(resolveServicePlatform("linux")).toBe("systemd");
    expect(resolveServicePlatform("win32")).toBe("unsupported");
    await expect(runServiceAction("install", { platform: "win32" })).rejects.toThrow(/macOS launchd/u);
  });

  it("rejects service paths that could inject definition lines", () => {
    expect(() => systemdServiceDefinition({ home: "/home/alice\nEnvironment=EVIL=1" })).toThrow(/control character/u);
  });

  it("installs, enables, and reports a systemd user service", async () => {
    const home = await temporaryHome();
    const calls: Array<[string, string[]]> = [];
    const runner = fakeRunner(calls, (command, args) => {
      if (command === "systemctl" && args.includes("is-active")) return result(command, args, 0, "active\n");
      return result(command, args, 0);
    });

    const status = await runServiceAction("install", {
      home,
      platform: "linux",
      nodePath: "/usr/bin/node",
      cliPath: "/opt/hermes-live/dist/cli.js",
      runner,
    });

    expect(status).toMatchObject({ platform: "systemd", installed: true, running: true });
    expect(calls).toContainEqual(["systemctl", ["--user", "daemon-reload"]]);
    expect(calls).toContainEqual(["systemctl", ["--user", "enable", SERVICE_LABEL]]);
  });

  it("bootstraps a launch agent in the current GUI domain", async () => {
    const home = await temporaryHome();
    const calls: Array<[string, string[]]> = [];
    const runner = fakeRunner(calls, (command, args) => result(command, args, 0));

    await runServiceAction("install", {
      home,
      platform: "darwin",
      nodePath: "/usr/bin/node",
      cliPath: "/opt/hermes-live/dist/cli.js",
      uid: 501,
      runner,
    });

    expect(calls.some(([command, args]) => command === "launchctl" && args[0] === "bootstrap" && args[1] === "gui/501"))
      .toBe(true);
  });

  it("reports an absent service without invoking its manager", async () => {
    const home = await temporaryHome();
    const runner: CommandRunner = async () => {
      throw new Error("runner should not be called");
    };

    await expect(serviceStatus({ home, platform: "linux", runner })).resolves.toMatchObject({
      installed: false,
      running: false,
    });
  });
});

function fakeRunner(
  calls: Array<[string, string[]]>,
  implementation: (command: string, args: string[]) => CommandResult,
): CommandRunner {
  return async (command, args) => {
    calls.push([command, [...args]]);
    return implementation(command, args);
  };
}

function result(command: string, args: string[], code: number, stdout = "", stderr = ""): CommandResult {
  return { command, args, code, stdout, stderr, timedOut: false };
}

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-service-"));
  temporaryDirectories.push(path);
  await mkdir(path, { recursive: true });
  return path;
}
