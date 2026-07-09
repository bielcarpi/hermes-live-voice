import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { HermesRunsPort } from "../src/application/live-gateway/ports/hermes-runs.port.js";
import { buildReadinessReport } from "../src/readiness.js";

describe("readiness", () => {
  it("reports missing Hermes and OpenAI credentials without probing the network", async () => {
    const report = await buildReadinessReport(
      loadConfig({
        HERMES_BASE_URL: "http://127.0.0.1:9",
        HERMES_LIVE_PROVIDER: "openai",
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.gateway).toMatchObject({ ok: true, host: "127.0.0.1" });
    expect(report.hermes).toMatchObject({
      ok: false,
      baseUrl: "http://127.0.0.1:9",
      error: "Set HERMES_AGENT_API_SERVER_KEY to Hermes Agent's API_SERVER_KEY.",
    });
    expect(report.realtime).toMatchObject({
      ok: false,
      configured: false,
      provider: "openai",
      sessionChecked: false,
      error: "Set OPENAI_API_KEY or use HERMES_LIVE_PROVIDER=mock for local text-only development.",
    });
  });

  it("supports injected clients without requiring default provider credentials", async () => {
    const hermes = {
      baseUrl: "http://injected-hermes.local",
      assertRunsSupported: vi.fn(async () => ({
        model: "hermes-agent",
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
        },
      })),
    } as unknown as HermesRunsPort;
    const report = await buildReadinessReport(
      loadConfig({
        HERMES_LIVE_PROVIDER: "openai",
      }),
      {
        hermes,
        requireHermesApiKey: false,
        requireRealtimeProviderConfig: false,
      },
    );

    expect(report.ok).toBe(true);
    expect(report.hermes).toMatchObject({ ok: true, baseUrl: "http://injected-hermes.local", model: "hermes-agent" });
    expect(report.realtime).toMatchObject({ ok: true, configured: true, injected: true, provider: "openai", sessionChecked: false });
    expect(hermes.assertRunsSupported).toHaveBeenCalledOnce();
  });

  it("reports local realtime provider configuration without OpenAI-specific fields", async () => {
    const report = await buildReadinessReport(
      loadConfig({
        HERMES_BASE_URL: "http://127.0.0.1:9",
        HERMES_LIVE_PROVIDER: "local",
        HERMES_LOCAL_REALTIME_BASE_URL: "ws://127.0.0.1:8765/v1/realtime",
        HERMES_LOCAL_REALTIME_VOICE: "Aiden",
      }),
    );

    expect(report.realtime).toMatchObject({
      ok: true,
      configured: true,
      provider: "local",
      model: "hf-realtime-voice",
      sessionChecked: false,
      baseUrl: "ws://127.0.0.1:8765/v1/realtime",
      voice: "Aiden",
    });
    expect(report.realtime).not.toHaveProperty("reasoningEffort");
    expect(report.realtime).not.toHaveProperty("turnDetection");
  });
});
