import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_VOICE_SERVICE_LABEL,
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
    expect(definition).toContain("<integer>5</integer>");
    expect(definition).not.toContain("API_KEY=");
  });

  it("escapes systemd paths and restarts only on failure", () => {
    const definition = systemdServiceDefinition({
      home: "/home/a user",
      nodePath: "/opt/node/bin/node",
      cliPath: "/home/a user/hermes-live/dist/cli.js",
      configPath: "/home/a user/.hermes/hermes-live/config.env",
    });

    expect(definition).toContain('ExecStart="/opt/node/bin/node" "/home/a user/hermes-live/dist/cli.js" "serve"');
    expect(definition).toContain('Environment="HERMES_LIVE_CONFIG_FILE=/home/a user/.hermes/hermes-live/config.env"');
    expect(definition).toContain("Restart=on-failure");
    expect(definition).not.toContain("API_KEY=");
  });

  it("generates an isolated local voice service without gateway secrets", () => {
    const definition = launchdServiceDefinition({
      kind: "local-voice",
      command: {
        command: "/opt/homebrew/bin/uv",
        args: ["tool", "run", "--from", "speech-to-speech==0.2.11", "speech-to-speech", "--mode", "realtime"],
        environment: { SSL_CERT_FILE: "/etc/ssl/cert.pem" },
      },
      home: "/Users/alice",
    });

    expect(definition).toContain(`<string>${LOCAL_VOICE_SERVICE_LABEL}</string>`);
    expect(definition).toContain("/opt/homebrew/bin/uv");
    expect(definition).toContain("speech-to-speech==0.2.11");
    expect(definition).toContain("local-voice.log");
    expect(definition).toContain("SSL_CERT_FILE");
    expect(definition).toContain("<integer>30</integer>");
    expect(definition).not.toContain("HERMES_LIVE_CONFIG_FILE");
    expect(definition).not.toContain("API_KEY");
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

  it("bounds launchd log growth when reinstalling a managed service", async () => {
    const home = await temporaryHome();
    const logs = join(home, ".hermes", "hermes-live", "logs");
    await mkdir(logs, { recursive: true });
    const logPath = join(logs, "gateway.log");
    await writeFile(logPath, Buffer.alloc(8 * 1024 * 1024 + 1, 65));

    await runServiceAction("install", {
      home,
      platform: "darwin",
      nodePath: "/usr/bin/node",
      cliPath: "/opt/hermes-live/dist/cli.js",
      uid: 501,
      runner: async (command, args) => result(command, args, 0),
    });

    await expect(stat(logPath)).resolves.toMatchObject({ size: 0 });
    expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(logs, "gateway.error.log"))).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform !== "win32")("refuses a symlinked launchd log without touching its target", async () => {
    const home = await temporaryHome();
    const logs = join(home, ".hermes", "hermes-live", "logs");
    const target = join(home, "must-not-change.txt");
    await mkdir(logs, { recursive: true });
    await writeFile(target, "keep me");
    await symlink(target, join(logs, "gateway.log"));

    await expect(runServiceAction("install", {
      home,
      platform: "darwin",
      nodePath: "/usr/bin/node",
      cliPath: "/opt/hermes-live/dist/cli.js",
      uid: 501,
      runner: async (command, args) => result(command, args, 0),
    })).rejects.toThrow(/regular file, not a symlink/u);
    await expect(readFile(target, "utf8")).resolves.toBe("keep me");
  });

  it.runIf(process.platform !== "win32")("refuses to read symlinked or public launchd logs", async () => {
    const home = await temporaryHome();
    const logs = join(home, ".hermes", "hermes-live", "logs");
    const target = join(home, "private.txt");
    await mkdir(logs, { recursive: true });
    await writeFile(target, "must not be returned");
    await symlink(target, join(logs, "gateway.log"));

    await expect(runServiceAction("logs", {
      home,
      platform: "darwin",
      uid: 501,
    })).rejects.toThrow(/private regular file/u);

    await rm(join(logs, "gateway.log"));
    await writeFile(join(logs, "gateway.log"), "private gateway output");
    await chmod(join(logs, "gateway.log"), 0o644);
    await expect(runServiceAction("logs", {
      home,
      platform: "darwin",
      uid: 501,
    })).rejects.toThrow(/other users/u);
  });

  it.runIf(process.platform !== "win32")("returns only a bounded tail from private launchd logs", async () => {
    const home = await temporaryHome();
    const logs = join(home, ".hermes", "hermes-live", "logs");
    await mkdir(logs, { recursive: true });
    await writeFile(
      join(logs, "gateway.log"),
      Array.from({ length: 240 }, (_, index) => `gateway line ${index + 1}`).join("\n"),
      { mode: 0o600 },
    );
    await writeFile(join(logs, "gateway.error.log"), "private warning", { mode: 0o600 });

    const result = await runServiceAction("logs", {
      home,
      platform: "darwin",
      uid: 501,
    });

    expect("stdout" in result && result.stdout).toContain("gateway line 240");
    expect("stdout" in result && result.stdout).not.toContain("gateway line 1\n");
    expect("stderr" in result && result.stderr).toBe("private warning");
  });

  it("boots out a stopped launch agent so KeepAlive cannot respawn it", async () => {
    const home = await temporaryHome();
    const definition = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(definition, "definition");
    const calls: Array<[string, string[]]> = [];
    const runner = fakeRunner(calls, (command, args) => {
      if (command === "launchctl" && args[0] === "print") return result(command, args, 3);
      return result(command, args, 0);
    });

    const status = await runServiceAction("stop", {
      home,
      platform: "darwin",
      uid: 501,
      runner,
    });

    expect(status).toMatchObject({
      installed: true,
      running: false,
      detail: "Gateway service is installed but not running.",
    });
    expect(calls).toContainEqual(["launchctl", ["bootout", "gui/501", definition]]);
    expect(calls.some(([command, args]) => command === "launchctl" && args.includes("kill"))).toBe(false);
  });

  it("bootstraps an installed launch agent after it has been stopped", async () => {
    const home = await temporaryHome();
    const definition = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(definition, "definition");
    const calls: Array<[string, string[]]> = [];
    let loaded = false;
    const runner = fakeRunner(calls, (command, args) => {
      if (command === "launchctl" && args[0] === "bootstrap") loaded = true;
      if (command === "launchctl" && args[0] === "print") {
        return result(command, args, loaded ? 0 : 3, loaded ? "state = running\n" : "");
      }
      return result(command, args, 0);
    });

    const status = await runServiceAction("start", {
      home,
      platform: "darwin",
      uid: 501,
      runner,
    });

    expect(status).toMatchObject({ installed: true, running: true });
    expect(calls).toContainEqual(["launchctl", ["bootstrap", "gui/501", definition]]);
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

  it("distinguishes a loaded launch agent from a running process", async () => {
    const home = await temporaryHome();
    const definition = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(definition, "definition");
    const waiting = await serviceStatus({
      home,
      platform: "darwin",
      uid: 501,
      runner: async (command, args) => result(command, args, 0, "state = waiting\n"),
    });
    const running = await serviceStatus({
      home,
      platform: "darwin",
      uid: 501,
      runner: async (command, args) => result(command, args, 0, "state = running\n"),
    });
    const starting = await serviceStatus({
      home,
      platform: "darwin",
      uid: 501,
      runner: async (command, args) => result(command, args, 0, "state = xpcproxy\npid = 4321\n"),
    });

    expect(waiting.running).toBe(false);
    expect(running.running).toBe(true);
    expect(starting.running).toBe(true);
  });

  it("refuses to start before the service is installed", async () => {
    const home = await temporaryHome();
    await expect(runServiceAction("start", {
      home,
      platform: "linux",
      runner: async (command, args) => result(command, args, 0),
    })).rejects.toThrow(/service is not installed/u);
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
