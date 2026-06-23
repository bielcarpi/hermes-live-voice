import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { HermesClient } from "../src/hermes/client.js";
import type { Logger } from "../src/logger.js";
import { MockLiveAdapter } from "../src/gemini/mock.js";
import { startServer } from "../src/server/http.js";

const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe("HTTP server", () => {
  it("serves health and capabilities", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    await expect(fetch(`${server.url}/health`).then((res) => res.json())).resolves.toMatchObject({
      status: "ok",
      service: "hermes-live",
    });
    await expect(fetch(`${server.url}/v1/capabilities`).then((res) => res.json())).resolves.toMatchObject({
      object: "hermes_live.capabilities",
      features: { hermes_runs: true, openai_realtime: true },
    });
  });

  it("can disable the built-in browser demo", async () => {
    const server = await startServer({
      config: testConfig({ server: { demoEnabled: false } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    expect(await fetch(`${server.url}/`).then((res) => res.status)).toBe(404);
    await expect(fetch(`${server.url}/v1/capabilities`).then((res) => res.json())).resolves.toMatchObject({
      features: { browser_demo: false },
    });
  });

  it("returns not_ready when Hermes capabilities fail", async () => {
    const hermes = fakeHermes();
    vi.mocked(hermes.assertRunsSupported).mockRejectedValueOnce(new Error("down"));
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/ready`);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("not_ready");
  });

  it("returns not_ready when Hermes is missing required run features", async () => {
    const hermes = fakeHermes();
    vi.mocked(hermes.assertRunsSupported).mockRejectedValueOnce(
      new Error("Hermes API Server is missing required features: run_events_sse"),
    );
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/ready`);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        hermes: {
          ok: false,
          error: "Error: Hermes API Server is missing required features: run_events_sse",
        },
      },
    });
  });

  it("honors CORS allowlist for configured origins", async () => {
    const server = await startServer({
      config: testConfig({ server: { allowOrigin: "https://app.example.com" } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/health`, { headers: { origin: "https://app.example.com" } });

    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(response.headers.get("access-control-allow-methods")).not.toContain("POST");
  });

  it("limits JSON endpoints to GET and HEAD", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const head = await fetch(`${server.url}/health`, { method: "HEAD" });
    const post = await fetch(`${server.url}/v1/capabilities`, { method: "POST" });

    expect(head.status).toBe(200);
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await head.text()).toBe("");
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    await expect(post.json()).resolves.toMatchObject({ status: "method_not_allowed" });
  });

  it("keeps health public but protects readiness and capabilities when auth is configured", async () => {
    const server = await startServer({
      config: testConfig({ server: { authToken: "secret-token" } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    expect(await fetch(`${server.url}/health`).then((res) => res.status)).toBe(200);
    expect(await fetch(`${server.url}/ready`).then((res) => res.status)).toBe(401);
    expect(await fetch(`${server.url}/v1/capabilities`).then((res) => res.status)).toBe(401);
    expect(await fetch(`${server.url}/v1/capabilities?token=secret-token`).then((res) => res.status)).toBe(401);

    const authorized = await fetch(`${server.url}/v1/capabilities`, {
      headers: { authorization: "Bearer secret-token" },
    });

    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      features: { auth_required: true },
    });
  });

  it("rejects startup when the listen port is already in use", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);
    const occupiedPort = Number(new URL(server.url).port);

    await expect(
      startServer({
        config: testConfig({ server: { port: occupiedPort } }),
        hermes: fakeHermes(),
        liveModel: new MockLiveAdapter(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/Failed to start hermes-live on 127\.0\.0\.1:\d+/);
  });
});

function fakeHermes(): HermesClient {
  return {
    baseUrl: "http://127.0.0.1:8642",
    capabilities: vi.fn(async () => ({
      model: "hermes-agent",
      features: {
        run_submission: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
      },
    })),
    assertRunsSupported: vi.fn(async () => ({
      model: "hermes-agent",
      features: {
        run_submission: true,
        run_events_sse: true,
        run_stop: true,
        run_approval_response: true,
      },
    })),
  } as unknown as HermesClient;
}

function testConfig(overrides: { server?: Partial<AppConfig["server"]> } = {}): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      sessionPrefix: "agent:main:hermes-live",
      maxAudioBytes: 2_000_000,
      maxTextChars: 20_000,
      providerReadyTimeoutMs: 15_000,
      demoEnabled: true,
      ...overrides.server,
      allowUnauthenticated: overrides.server?.allowUnauthenticated ?? false,
    },
    hermes: { baseUrl: "http://127.0.0.1:8642", model: "hermes-agent", timeoutMs: 30_000 },
    realtime: { provider: "openai", model: "gpt-realtime-2" },
    gemini: { model: "gemini-3.1-flash-live-preview", enterprise: false, location: "us-central1" },
    openai: {
      apiKey: "test",
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime-2",
      voice: "marin",
      reasoningEffort: "low",
      turnDetection: "disabled",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
    },
  };
}

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
