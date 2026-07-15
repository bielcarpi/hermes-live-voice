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
    expect(report.gateway).toMatchObject({
      ok: true,
      host: "127.0.0.1",
      tasks: { durable: true, maxConcurrent: 3, maxQueued: 32, maxRetained: 200 },
    });
    expect(report.hermes).toMatchObject({
      ok: false,
      baseUrl: "http://127.0.0.1:9",
      approvals: {
        uiSupported: false,
        interactive: false,
        fallback: "deny_all_then_stop",
        requiredFeature: "run_approval_response_by_id",
        negotiated: false,
      },
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
    expect(report.hermes).toMatchObject({
      ok: true,
      baseUrl: "http://injected-hermes.local",
      model: "hermes-agent",
      approvals: {
        uiSupported: false,
        interactive: false,
        fallback: "deny_all_then_stop",
        requiredFeature: "run_approval_response_by_id",
        negotiated: true,
      },
    });
    expect(report.realtime).toMatchObject({ ok: true, configured: true, injected: true, provider: "openai", sessionChecked: false });
    expect(hermes.assertRunsSupported).toHaveBeenCalledOnce();
  });

  it("never exposes base URL userinfo or query credentials", async () => {
    const report = await buildReadinessReport(
      loadConfig({
        HERMES_LIVE_PROVIDER: "openai",
        OPENAI_REALTIME_BASE_URL:
          "wss://realtime.example/tenant/readiness-path-secret?api-version=2026-07-01&api-key=query-secret",
      }),
    );

    expect(report.realtime.baseUrl).toBe("wss://realtime.example/[redacted-path]?[redacted]");
    expect(JSON.stringify(report)).not.toContain("query-secret");
    expect(JSON.stringify(report)).not.toContain("readiness-path-secret");
    expect(JSON.stringify(report)).not.toContain("api-version");
  });

  it("records upstream targeting but keeps v0.5 approvals fail-closed", async () => {
    const hermes = {
      baseUrl: "http://targeted-hermes.local",
      assertRunsSupported: vi.fn(async () => ({
        model: "hermes-agent",
        features: {
          run_submission: true,
          run_events_sse: true,
          run_stop: true,
          run_approval_response: true,
          run_approval_response_by_id: true,
        },
      })),
    } as unknown as HermesRunsPort;

    const report = await buildReadinessReport(loadConfig({ HERMES_LIVE_PROVIDER: "mock" }), {
      hermes,
      requireHermesApiKey: false,
      requireRealtimeProviderConfig: false,
    });

    expect(report.hermes).toMatchObject({
      ok: true,
      approvals: {
        uiSupported: false,
        interactive: false,
        upstreamTargetedResponseAdvertised: true,
        fallback: "deny_all_then_stop",
        requiredFeature: "run_approval_response_by_id",
        negotiated: true,
      },
    });
  });
});
