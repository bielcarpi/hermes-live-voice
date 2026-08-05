import { createServer } from "node:http";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readManagedConfig, writeManagedConfig } from "../src/cli/managed-config.js";
import {
  parseSetupOptions,
  resolveSetupGatewayPort,
  resolveSetupLocalVoiceUrl,
  runSetup,
} from "../src/cli/setup.js";
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
            ...sessionFeatures(),
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
        gatewayEndpointProbe: async () => "available",
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
        HERMES_LIVE_DEMO_ENABLED: "false",
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

  it("does not change Hermes configuration before provider validation succeeds", async () => {
    const home = await temporaryHome();
    const hermesCommand = join(home, "bin", "hermes");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    await expect(runSetup({
      provider: "openai",
      enablePlugin: true,
      service: true,
      nonInteractive: true,
      json: true,
    }, {
      home,
      env: { PATH: join(home, "bin") },
      findCommand: async (name) => name === "hermes" ? hermesCommand : undefined,
    })).rejects.toThrow(/OpenAI API key is required/u);

    await expect(lstat(join(home, ".hermes", ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readManagedConfig({ home })).resolves.toMatchObject({ exists: false });
  });

  it("does not change Hermes configuration when the managed local runtime is missing", async () => {
    const home = await temporaryHome();
    const hermesCommand = join(home, "bin", "hermes");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    await expect(runSetup({
      provider: "local",
      enablePlugin: true,
      service: true,
      nonInteractive: true,
      json: true,
    }, {
      home,
      platform: "darwin",
      arch: "arm64",
      env: { PATH: join(home, "bin") },
      findCommand: async (name) => name === "hermes" ? hermesCommand : undefined,
      gatewayEndpointProbe: async () => "available",
      localEndpointProbe: async () => false,
    })).rejects.toThrow(/uv is required/u);

    await expect(lstat(join(home, ".hermes", ".env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readManagedConfig({ home })).resolves.toMatchObject({ exists: false });
  });

  it("bootstraps the default local Hermes API without asking for an internal key", async () => {
    const home = await temporaryHome();
    const hermesCommand = join(home, "bin", "hermes");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(hermesCommand, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const calls: Array<[string, string[]]> = [];
    let liveServiceStarted = false;
    let readinessCalls = 0;
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      if (command === "systemctl" && args.includes("start")) liveServiceStarted = true;
      if (command === "systemctl" && args.includes("is-active")) {
        return {
          ...commandResult(command, args, liveServiceStarted ? "active\n" : "inactive\n"),
          code: liveServiceStarted ? 0 : 3,
        };
      }
      return commandResult(command, args);
    };
    const readinessCheck = async () => {
      readinessCalls += 1;
      const hermesReady = readinessCalls > 1;
      return {
        ok: hermesReady,
        gateway: { ok: true },
        hermes: hermesReady ? { ok: true, baseUrl: "http://127.0.0.1:8642" } : { ok: false, error: "offline" },
        realtime: { ok: true },
        tasks: { ok: true },
      };
    };

    const report = await runSetup({
      provider: "mock",
      enablePlugin: true,
      service: true,
      nonInteractive: true,
      json: true,
    }, {
      home,
      platform: "linux",
      env: { PATH: join(home, "bin") },
      runner,
      findCommand: async (name) => name === "hermes" ? hermesCommand : undefined,
      gatewayEndpointProbe: async () => "available",
      readinessCheck,
      fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.plugin.target).toBe(join(home, ".hermes", "plugins", "hermes-live"));
    expect(report.hermesGateway).toMatchObject({ managed: true, configured: true, ready: true, action: "installed" });
    expect(calls).toContainEqual([hermesCommand, ["gateway", "install", "--force"]]);
    const hermesEnvironment = await readFile(join(home, ".hermes", ".env"), "utf8");
    expect(hermesEnvironment).toContain('API_SERVER_ENABLED="true"');
    const generatedKey = /API_SERVER_KEY="([a-f0-9]{64})"/u.exec(hermesEnvironment)?.[1];
    expect(generatedKey).toBeTruthy();
    expect(JSON.stringify(report)).not.toContain(generatedKey);
    const managed = await readManagedConfig({ home });
    expect(managed.values.HERMES_AGENT_API_SERVER_KEY).toBe(generatedKey);
  });

  it("requires an explicit provider in headless setup when local voice is not managed", async () => {
    const home = await temporaryHome();
    await expect(runSetup({
      enablePlugin: false,
      service: false,
      nonInteractive: true,
      json: true,
    }, {
      home,
      platform: "linux",
      arch: "x64",
      env: { HERMES_AGENT_API_SERVER_KEY: "private" },
    })).rejects.toThrow(/No voice provider was selected/u);
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
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const calls: Array<[string, string[]]> = [];
    let serviceStarted = false;
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      if (command === "systemctl" && args.includes("start")) serviceStarted = true;
      if (command === "systemctl" && args.includes("is-active")) {
        return {
          ...commandResult(command, args, serviceStarted ? "active\n" : "inactive\n"),
          code: serviceStarted ? 0 : 3,
        };
      }
      return commandResult(command, args);
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
        gatewayEndpointProbe: async () => "available",
        fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
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

  it("starts managed local voice before verifying it and starting the gateway", async () => {
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
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const events: string[] = [];
    const progress: string[] = [];
    const active = new Set<string>();
    const runner: CommandRunner = async (command, args) => {
      if (command === "launchctl" && args[0] === "bootstrap") {
        const label = args[2]?.includes(".local.plist")
          ? "dev.hermes-live-voice.local"
          : "dev.hermes-live-voice.gateway";
        active.add(label);
        events.push(`start:${label}`);
      }
      if (command === "launchctl" && args[0] === "print") {
        const label = args[1]?.split("/").at(-1) ?? "";
        return {
          ...commandResult(command, args, active.has(label) ? "state = running\n" : "state = waiting\n"),
          code: active.has(label) ? 0 : 3,
        };
      }
      return commandResult(command, args);
    };
    try {
      const report = await runSetup({
        hermesUrl: `http://127.0.0.1:${address.port}`,
        pluginsDir,
        enablePlugin: false,
        service: true,
        nonInteractive: true,
        json: true,
      }, {
        home,
        platform: "darwin",
        arch: "arm64",
        uid: 501,
        env: { HERMES_AGENT_API_SERVER_KEY: "private" },
        runner,
        findCommand: async (name) => name === "uv" ? "/opt/homebrew/bin/uv" : undefined,
        gatewayEndpointProbe: async () => "available",
        localEndpointProbe: async (url) => new URL(url).port === "8765",
        progress: (message) => progress.push(message),
        providerSessionCheck: async () => {
          events.push("provider:check");
          return { checked: true, ok: true };
        },
        fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });

      expect(report.ok).toBe(true);
      expect(report.provider).toBe("local");
      expect(report.localService).toMatchObject({ installed: true, running: true });
      expect(report.service).toMatchObject({ installed: true, running: true });
      expect(events).toEqual([
        "start:dev.hermes-live-voice.local",
        "provider:check",
        "start:dev.hermes-live-voice.gateway",
      ]);
      expect(report.nextSteps).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/another terminal/u),
      ]));
      const managed = await readManagedConfig({ home });
      expect(managed.values.HERMES_LIVE_LOCAL_URL).toBe("ws://127.0.0.1:8766/v1/realtime");
      expect(managed.values.HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING).toBe("true");
      expect(progress).toContain("Local voice port 8765 is already in use. Hermes Live Voice will use 8766.");
      await expect(readFile(
        join(home, "Library", "LaunchAgents", "dev.hermes-live-voice.local.plist"),
        "utf8",
      )).resolves.toContain("<string>8766</string>");
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("does not carry managed turn routing into an external local endpoint", async () => {
    const home = await temporaryHome();
    await writeManagedConfig({
      HERMES_AGENT_API_SERVER_KEY: "private",
      HERMES_LIVE_PROVIDER: "local",
      HERMES_LIVE_LOCAL_URL: "ws://127.0.0.1:8765/v1/realtime",
      HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING: "true",
    }, { home });
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
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");

    try {
      const report = await runSetup({
        provider: "local",
        hermesUrl: `http://127.0.0.1:${address.port}`,
        enablePlugin: false,
        service: false,
        nonInteractive: true,
        json: true,
      }, {
        home,
        platform: "darwin",
        arch: "arm64",
        env: {
          HERMES_AGENT_API_SERVER_KEY: "private",
          HERMES_LIVE_LOCAL_URL: "ws://voice.internal:8765/v1/realtime",
          HERMES_LIVE_LOCAL_ALLOW_REMOTE: "true",
        },
        gatewayEndpointProbe: async () => "available",
        providerSessionCheck: async () => ({ checked: true, ok: true }),
      });

      expect(report.ok).toBe(true);
      const managed = await readManagedConfig({ home });
      expect(managed.values.HERMES_LIVE_LOCAL_URL).toBe("ws://voice.internal:8765/v1/realtime");
      expect(managed.values.HERMES_LIVE_LOCAL_OWNS_TURN_ROUTING).toBeUndefined();
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("removes a managed local voice service when setup switches providers", async () => {
    const home = await temporaryHome();
    const localDefinition = join(home, "Library", "LaunchAgents", "dev.hermes-live-voice.local.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(localDefinition, "old local service");
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
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server.");
    const calls: Array<[string, string[]]> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push([command, [...args]]);
      if (command === "launchctl" && args[0] === "print") {
        return { ...commandResult(command, args, "state = running\n"), code: 0 };
      }
      return commandResult(command, args);
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
        platform: "darwin",
        arch: "arm64",
        uid: 501,
        env: { HERMES_AGENT_API_SERVER_KEY: "private" },
        runner,
        gatewayEndpointProbe: async () => "available",
        fetch: async () => new Response(JSON.stringify({ status: "ready", service: "hermes-live", checks: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      });

      expect(report.ok).toBe(true);
      expect(report.localService).toMatchObject({ installed: false, running: false });
      expect(calls).toContainEqual(["launchctl", ["bootout", "gui/501", localDefinition]]);
      await expect(import("node:fs/promises").then(({ access }) => access(localDefinition))).rejects.toThrow();
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("does not install a service when plugin enablement fails", async () => {
    const home = await temporaryHome();
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
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
        gatewayEndpointProbe: async () => "available",
      });

      expect(report.ok).toBe(false);
      expect(report.service).toMatchObject({ skipped: true });
      expect(calls.some(([command]) => command === "systemctl")).toBe(false);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("moves an implicit gateway port when another service owns it", async () => {
    const progress: string[] = [];
    const probed: number[] = [];
    const port = await resolveSetupGatewayPort({
      host: "127.0.0.1",
      port: 8788,
      explicit: false,
      probe: async (_host, candidate) => {
        probed.push(candidate);
        return candidate === 8788 ? "occupied" : candidate === 8789 ? "occupied" : "available";
      },
      progress: (message) => progress.push(message),
    });

    expect(port).toBe(8790);
    expect(probed).toEqual([8788, 8789, 8790]);
    expect(progress).toEqual(["Port 8788 is already in use. Hermes Live Voice will use 8790."]);
  });

  it("does not override an explicitly configured occupied port", async () => {
    await expect(resolveSetupGatewayPort({
      host: "127.0.0.1",
      port: 8788,
      explicit: true,
      probe: async () => "occupied",
    })).rejects.toThrow(/Choose a free HERMES_LIVE_PORT/u);
  });

  it("moves an implicit local voice port when another process owns it", async () => {
    const progress: string[] = [];
    const probed: number[] = [];
    const url = await resolveSetupLocalVoiceUrl({
      url: "ws://127.0.0.1:8765/v1/realtime",
      explicit: false,
      probe: async (candidate) => {
        const port = Number(new URL(candidate).port);
        probed.push(port);
        return port < 8767;
      },
      progress: (message) => progress.push(message),
    });

    expect(url).toBe("ws://127.0.0.1:8767/v1/realtime");
    expect(probed).toEqual([8765, 8766, 8767]);
    expect(progress).toEqual(["Local voice port 8765 is already in use. Hermes Live Voice will use 8767."]);
  });

  it("keeps a listening local endpoint owned by the managed service", async () => {
    await expect(resolveSetupLocalVoiceUrl({
      url: "ws://127.0.0.1:8765/v1/realtime",
      explicit: false,
      ownedServiceUrl: "ws://127.0.0.1:8765/v1/realtime",
      probe: async () => true,
    })).resolves.toBe("ws://127.0.0.1:8765/v1/realtime");
  });

  it("does not treat a running managed service as the owner of a different endpoint", async () => {
    await expect(resolveSetupLocalVoiceUrl({
      url: "ws://127.0.0.1:8766/v1/realtime",
      explicit: true,
      ownedServiceUrl: "ws://127.0.0.1:8765/v1/realtime",
      probe: async () => true,
    })).rejects.toThrow(/Choose a free HERMES_LIVE_LOCAL_URL/u);
  });

  it("does not override an explicitly configured occupied local endpoint", async () => {
    await expect(resolveSetupLocalVoiceUrl({
      url: "ws://127.0.0.1:8765/v1/realtime",
      explicit: true,
      probe: async () => true,
    })).rejects.toThrow(/Choose a free HERMES_LIVE_LOCAL_URL/u);
  });
});

function commandResult(command: string, args: string[], stdout = ""): CommandResult {
  return { command, args, code: 0, stdout, stderr: "", timedOut: false };
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

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hermes-live-setup-"));
  temporaryDirectories.push(path);
  return path;
}
