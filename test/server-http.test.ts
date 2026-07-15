import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import type { HermesRunsPort } from "../src/application/live-gateway/ports/hermes-runs.port.js";
import type { Logger } from "../src/logger.js";
import { MockLiveAdapter } from "../src/adapters/outbound/realtime/mock-live.adapter.js";
import { startServer } from "../src/adapters/inbound/http/server.js";

const openServers: Array<{ close(): Promise<void> }> = [];
const taskStateDirectory = realpathSync(tmpdir());
const taskStateDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  for (const directory of taskStateDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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
      protocolVersion: 3,
      realtime: {
        provider: "openai",
        model: "gpt-realtime-2.1",
        audio: {
          input: { enabled: true, mimeType: "audio/pcm;rate=24000", recommendedFrameMs: 50 },
          output: { enabled: true, mimeType: "audio/pcm;rate=24000" },
          turnDetection: "disabled",
        },
      },
      hermes: {
        approvals: {
          uiSupported: false,
          interactive: false,
          fallback: "deny_all_then_stop",
          requiredFeature: "run_approval_response_by_id",
          negotiated: true,
        },
      },
      tasks: {
        scope: "owner",
        durable: true,
        persistence: "local_file",
        disconnectContinuation: true,
        gatewayRestartRecovery: "reconcile_by_upstream_run_id",
        hermesRestartRecovery: false,
        ambiguousDispatch: "fenced_no_automatic_retry",
        maxConcurrent: 3,
        maxQueued: 32,
        maxRetained: 200,
      },
      features: {
        background_tasks: true,
        durable_task_state: true,
        task_reconnect_snapshot: true,
        exact_task_stop: true,
        task_notifications: true,
        openai_realtime: true,
        hermes_approval: false,
        hermes_approval_ui: false,
        hermes_approval_fallback_deny_all: true,
        hermes_approval_fallback_stops_run: true,
        hermes_approval_requires_targeted_response: true,
      },
    });
  });

  it("keeps approvals fail-closed even when Hermes advertises targeted responses", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes({ run_approval_response_by_id: true }),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    await expect(fetch(`${server.url}/v1/capabilities`).then((res) => res.json())).resolves.toMatchObject({
      hermes: {
        approvals: {
          uiSupported: false,
          interactive: false,
          upstreamTargetedResponseAdvertised: true,
          fallback: "deny_all_then_stop",
          requiredFeature: "run_approval_response_by_id",
          negotiated: true,
        },
      },
      features: { hermes_approval: false, hermes_approval_ui: false },
    });
  });

  it("marks approval negotiation unavailable without inventing an approval UI", async () => {
    const hermes = fakeHermes();
    vi.mocked(hermes.capabilities).mockRejectedValueOnce(new Error("Hermes unavailable"));
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/v1/capabilities`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hermes: {
        approvals: {
          uiSupported: false,
          interactive: false,
          fallback: "deny_all_then_stop",
          requiredFeature: "run_approval_response_by_id",
          negotiated: false,
        },
      },
      features: { hermes_approval: false, hermes_approval_ui: false },
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

  it("serves the browser demo with defensive security headers", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("hermes-live");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves the canonical browser client imported by the demo", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/hermes-live-client.js`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(body).toContain("export class HermesLiveClient");
    expect(body).toContain("export class HermesLiveAudio");

    const worklet = await fetch(`${server.url}/mic-worklet.js`);
    expect(worklet.status).toBe(200);
    expect(worklet.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    await expect(worklet.text()).resolves.toContain('registerProcessor("pcm-capture"');
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
        gateway: {
          ok: true,
          authRequired: false,
        },
        hermes: {
          ok: false,
          baseUrl: "http://127.0.0.1:8642",
          error: "Hermes API Server is missing required features: run_events_sse",
        },
        realtime: {
          ok: true,
          configured: true,
          injected: true,
          provider: "openai",
          sessionChecked: false,
        },
      },
    });
  });

  it("reports injected realtime providers explicitly in readiness", async () => {
    const server = await startServer({
      config: testConfig({ openai: { apiKey: undefined } }),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        hermes: { ok: true, baseUrl: "http://127.0.0.1:8642" },
        realtime: {
          ok: true,
          configured: true,
          injected: true,
          provider: "openai",
          model: "gpt-realtime-2.1",
          sessionChecked: false,
        },
      },
    });
  });

  it("logs internal HTTP failures without exposing their details to clients", async () => {
    const hermes = fakeHermes();
    vi.mocked(hermes.assertRunsSupported).mockResolvedValueOnce({
      model: "hermes-agent",
      features: { nonSerializableInternalValue: 1n },
    });
    const logger = fakeLogger();
    const server = await startServer({
      config: testConfig(),
      hermes,
      liveModel: new MockLiveAdapter(),
      logger,
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/ready`);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ status: "error", error: "Internal server error." });
    expect(logger.error).toHaveBeenCalledWith("http handler failed", {
      error: expect.stringContaining("BigInt"),
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

  it("rejects malformed WebSocket upgrades without taking down the HTTP server", async () => {
    const server = await startServer({
      config: testConfig(),
      hermes: fakeHermes(),
      liveModel: new MockLiveAdapter(),
      logger: fakeLogger(),
    });
    openServers.push(server);

    const malformedTarget = await rawHttpRequest(
      server.url,
      "GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    const malformedHost = await rawHttpRequest(
      server.url,
      "GET /v1/live HTTP/1.1\r\nHost: [\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );

    expect(malformedTarget).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(malformedHost).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    await expect(fetch(`${server.url}/health`).then((res) => res.json())).resolves.toMatchObject({
      status: "ok",
      service: "hermes-live",
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

  it("rejects network-accessible starts without gateway auth even through the library API", async () => {
    await expect(
      startServer({
        config: testConfig({ server: { host: "0.0.0.0" } }),
        hermes: fakeHermes(),
        liveModel: new MockLiveAdapter(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/HERMES_LIVE_AUTH_TOKEN/);
  });

  it("rejects default Hermes clients without Hermes API credentials through the library API", async () => {
    await expect(
      startServer({
        config: testConfig(),
        liveModel: new MockLiveAdapter(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/HERMES_AGENT_API_SERVER_KEY/);
  });

  it("rejects default realtime providers without provider credentials through the library API", async () => {
    await expect(
      startServer({
        config: testConfig({ openai: { apiKey: undefined } }),
        hermes: fakeHermes(),
        logger: fakeLogger(),
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

function fakeHermes(extraFeatures: Record<string, unknown> = {}): HermesRunsPort {
  const capabilities = {
    model: "hermes-agent",
    features: {
      run_submission: true,
      run_events_sse: true,
      run_stop: true,
      run_approval_response: true,
      ...extraFeatures,
    },
  };
  return {
    baseUrl: "http://127.0.0.1:8642",
    capabilities: vi.fn(async () => capabilities),
    assertRunsSupported: vi.fn(async () => capabilities),
  } as unknown as HermesRunsPort;
}

function rawHttpRequest(serverUrl: string, request: string): Promise<string> {
  const url = new URL(serverUrl);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(2_000);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
    socket.on("timeout", () => socket.destroy(new Error("Timed out waiting for the raw HTTP response.")));
  });
}

function testConfig(
  overrides: {
    server?: Partial<AppConfig["server"]>;
    hermes?: Partial<AppConfig["hermes"]>;
    realtime?: Partial<AppConfig["realtime"]>;
    gemini?: Partial<AppConfig["gemini"]>;
    openai?: Partial<AppConfig["openai"]>;
  } = {},
): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 0,
      sessionPrefix: "agent:main:hermes-live",
      defaultProfileId: "default",
      defaultUserLabel: "voice",
      trustClientIdentity: false,
      maxSessions: 8,
      maxAudioBytes: 2_000_000,
      maxTextChars: 20_000,
      providerReadyTimeoutMs: 15_000,
      demoEnabled: true,
      ...overrides.server,
      allowUnauthenticated: overrides.server?.allowUnauthenticated ?? false,
    },
    hermes: {
      baseUrl: "http://127.0.0.1:8642",
      model: "hermes-agent",
      timeoutMs: 30_000,
      streamIdleTimeoutMs: 120_000,
      ...overrides.hermes,
    },
    tasks: {
      stateFile: createTaskStateFile("hermes-live-http-test-"),
      maxConcurrent: 3,
      maxQueued: 32,
      historyLimit: 200,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      pollIntervalMs: 25,
    },
    realtime: { provider: "openai", model: "gpt-realtime-2.1", ...overrides.realtime },
    gemini: { model: "gemini-3.1-flash-live-preview", enterprise: false, location: "us-central1", ...overrides.gemini },
    openai: {
      apiKey: "test",
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime-2.1",
      voice: "marin",
      reasoningEffort: "low",
      turnDetection: "disabled",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
      ...overrides.openai,
    },
  };
}

function createTaskStateFile(prefix: string): string {
  const directory = mkdtempSync(join(taskStateDirectory, prefix));
  taskStateDirectories.push(directory);
  return join(directory, "tasks-v1.json");
}

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}
