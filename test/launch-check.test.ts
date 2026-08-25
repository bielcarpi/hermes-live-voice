import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  parseLaunchCheckOptions,
  runLaunchCheck,
} from "../src/cli/launch-check.js";

const packageRequire = createRequire(import.meta.url);
const PACKAGE_VERSION = (packageRequire("../package.json") as { version: string }).version;

describe("launch-check", () => {
  it("parses json and timeout options", () => {
    expect(parseLaunchCheckOptions(["--json", "--timeout-ms", "12345"])).toEqual({
      json: true,
      timeoutMs: 12345,
    });
    expect(() => parseLaunchCheckOptions(["--timeout-ms", "0"])).toThrow(/positive integer/u);
  });

  it("rejects mock mode because it cannot prove real voice", async () => {
    await expect(
      runLaunchCheck({ json: true }, {
        config: loadConfig({ HERMES_LIVE_PROVIDER: "mock" }),
      }),
    ).rejects.toThrow("HERMES_LIVE_PROVIDER=mock is for development");
  });

  it("proves provider, plugin, gateway, and exact Hermes worker output", async () => {
    const config = loadConfig({
      HERMES_LIVE_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-launch-secret",
      HERMES_AGENT_API_SERVER_KEY: "hermes-launch-secret",
    });
    const providerSmoke = vi.fn(async (_config: unknown, _options: unknown) => ({
      ok: true,
      provider: "openai",
      model: "gpt-realtime-2.1",
      connected: true,
      openCallback: true,
      elapsedMs: 1,
      eventCount: 0,
      sampleEvents: [] as Array<Record<string, unknown>>,
    } as const));
    const hermes = {
      assertRunsSupported: vi.fn(async () => ({ features: {} })),
      startRun: vi.fn(async () => ({ runId: "run_launch", status: "queued" as const })),
      streamRunEvents: vi.fn(async function* () {
        yield { event: "run.completed" as const };
      }),
      getRun: vi.fn(async () => ({
        object: "hermes.run" as const,
        run_id: "run_launch",
        status: "completed" as const,
        output: "HERMES_LIVE_WORKER_OK",
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      })),
    };

    const report = await runLaunchCheck({ json: true, timeoutMs: 123_000 }, {
      config,
      readinessCheck: async () => ({
        ok: true,
        gateway: { ok: true },
        hermes: { ok: true },
        realtime: { ok: true },
        tasks: { ok: true },
      }),
      pluginStatus: async () => ({
        source: "/pkg/plugins/hermes-live",
        target: "/home/alice/.hermes/plugins/hermes-live",
        installed: true,
        manifestFound: true,
        symlink: false,
        enabledHint: "Run `hermes plugins enable hermes-live` after installation.",
      }),
      pluginVersion: async () => PACKAGE_VERSION,
      serviceStatus: async () => ({
        platform: "launchd",
        installed: true,
        running: true,
        detail: "running",
      }),
      gatewayReadiness: async () => ({ ok: true }),
      providerSmoke,
      hermes,
      now: () => 1_000,
    });

    expect(report.ok).toBe(true);
    expect(report.plugin.version).toBe(PACKAGE_VERSION);
    expect(report.worker).toEqual({
      runId: "run_launch",
      status: "completed",
      outputVerified: true,
    });
    expect(providerSmoke).toHaveBeenCalledWith(config, { timeoutMs: 123_000 });
    expect(hermes.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.stringContaining("HERMES_LIVE_WORKER_OK"),
        sessionId: expect.stringMatching(/^hermes_live_launch_check_1000_[a-f0-9]{8}$/u),
        sessionKey: expect.stringContaining(":launch-check"),
      }),
      expect.any(AbortSignal),
    );
    expect(hermes.getRun).toHaveBeenCalledWith("run_launch", expect.objectContaining({
      sessionKey: expect.stringContaining(":launch-check"),
    }));
  });

  it("rejects a stale installed plugin", async () => {
    const config = loadConfig({
      HERMES_LIVE_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-launch-secret",
      HERMES_AGENT_API_SERVER_KEY: "hermes-launch-secret",
    });

    await expect(runLaunchCheck({ json: true }, {
      config,
      readinessCheck: async () => ({
        ok: true,
        gateway: { ok: true },
        hermes: { ok: true },
        realtime: { ok: true },
        tasks: { ok: true },
      }),
      pluginStatus: async () => ({
        source: "/pkg/plugins/hermes-live",
        target: "/home/alice/.hermes/plugins/hermes-live",
        installed: true,
        manifestFound: true,
        symlink: false,
        enabledHint: "Run `hermes plugins enable hermes-live` after installation.",
      }),
      pluginVersion: async () => "0.0.0",
    })).rejects.toThrow("Run `hermes-live upgrade`");
  });

  it("requires the exact Hermes launch token", async () => {
    const config = loadConfig({
      HERMES_LIVE_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-launch-secret",
      HERMES_AGENT_API_SERVER_KEY: "hermes-launch-secret",
    });
    const hermes = {
      assertRunsSupported: vi.fn(async () => ({ features: {} })),
      startRun: vi.fn(async () => ({ runId: "run_launch", status: "queued" as const })),
      streamRunEvents: vi.fn(async function* () {
        yield { event: "run.completed" as const };
      }),
      getRun: vi.fn(async () => ({
        object: "hermes.run" as const,
        run_id: "run_launch",
        status: "completed" as const,
        output: "close enough",
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      })),
    };

    await expect(runLaunchCheck({ json: true }, {
      config,
      readinessCheck: async () => ({
        ok: true,
        gateway: { ok: true },
        hermes: { ok: true },
        realtime: { ok: true },
        tasks: { ok: true },
      }),
      pluginStatus: async () => ({
        source: "/pkg/plugins/hermes-live",
        target: "/home/alice/.hermes/plugins/hermes-live",
        installed: true,
        manifestFound: true,
        symlink: false,
        enabledHint: "Run `hermes plugins enable hermes-live` after installation.",
      }),
      pluginVersion: async () => PACKAGE_VERSION,
      serviceStatus: async () => ({
        platform: "launchd",
        installed: false,
        running: false,
        detail: "not installed",
      }),
      gatewayReadiness: async () => ({ ok: true }),
      providerSmoke: async () => ({
        ok: true,
        provider: "openai",
        model: "gpt-realtime-2.1",
        connected: true,
        openCallback: true,
        elapsedMs: 1,
        eventCount: 0,
        sampleEvents: [] as Array<Record<string, unknown>>,
      } as const),
      hermes,
    })).rejects.toThrow("exact launch-check token");
  });
});
