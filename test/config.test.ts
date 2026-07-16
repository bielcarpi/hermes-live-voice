import { describe, expect, it } from "vitest";
import {
  MAX_COMPATIBLE_AUDIO_FRAME_BYTES,
  MAX_COMPATIBLE_TEXT_CHARS,
  assertRuntimeConfig,
  loadConfig,
  makeSessionKey,
  publicBaseUrl,
  realtimeProviderConfigured,
  sanitizeSessionComponent,
} from "../src/config.js";

describe("config", () => {
  it("loads defaults and selects Gemini as the default provider", () => {
    const config = loadConfig({});

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(8788);
    expect(config.server.demoEnabled).toBe(true);
    expect(config.server.allowUnauthenticated).toBe(false);
    expect(config.server.defaultProfileId).toBe("default");
    expect(config.server.defaultUserLabel).toBe("voice");
    expect(config.server.trustClientIdentity).toBe(false);
    expect(config.server.maxSessions).toBe(8);
    expect(config.server.maxTextChars).toBe(20_000);
    expect(config.server.providerReadyTimeoutMs).toBe(15_000);
    expect(config.hermes.baseUrl).toBe("http://127.0.0.1:8642");
    expect(config.hermes.timeoutMs).toBe(30_000);
    expect(config.hermes.streamIdleTimeoutMs).toBe(120_000);
    expect(config.tasks).toMatchObject({
      maxConcurrent: 3,
      maxQueued: 32,
      historyLimit: 200,
      retentionMs: 7 * 24 * 60 * 60 * 1_000,
      pollIntervalMs: 2_000,
    });
    expect(config.tasks.stateFile).toMatch(/tasks-v1\.json$/u);
    expect(config.realtime.provider).toBe("gemini");
    expect(config.gemini.model).toBe("gemini-3.1-flash-live-preview");
    expect(config.realtime.model).toBe(config.gemini.model);
  });

  it("uses PORT over HERMES_LIVE_PORT", () => {
    const config = loadConfig({ PORT: "9000", HERMES_LIVE_PORT: "8788" });

    expect(config.server.port).toBe(9000);
  });

  it("configures the Hermes request timeout", () => {
    const config = loadConfig({ HERMES_LIVE_HERMES_TIMEOUT_MS: "1200" });

    expect(config.hermes.timeoutMs).toBe(1200);
  });

  it("rejects disabled or negative Hermes request timeouts", () => {
    expect(() => loadConfig({ HERMES_LIVE_HERMES_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_HERMES_TIMEOUT_MS: "-1" })).toThrow();
  });

  it("configures a positive Hermes event-stream idle timeout", () => {
    expect(loadConfig({ HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS: "45000" }).hermes.streamIdleTimeoutMs)
      .toBe(45_000);
    expect(() => loadConfig({ HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_HERMES_STREAM_IDLE_TIMEOUT_MS: "-1" })).toThrow();
  });

  it("requires a credential-free HTTP(S) root origin for Hermes", () => {
    expect(loadConfig({ HERMES_BASE_URL: "HTTPS://hermes.example/" }).hermes.baseUrl)
      .toBe("HTTPS://hermes.example");
    for (const baseUrl of [
      "ws://hermes.example",
      "ftp://hermes.example",
      "http://user:secret@hermes.example",
      "http://hermes.example/base",
      "http://hermes.example?token=secret",
      "http://hermes.example#fragment",
      " http://hermes.example",
      "http://hermes.example\\@attacker.example",
      `http://${"x".repeat(2_048)}`,
    ]) {
      expect(() => loadConfig({ HERMES_BASE_URL: baseUrl })).toThrow();
    }
  });

  it("requires a credential-free WS(S) URL for OpenAI while preserving custom path and query", () => {
    const baseUrl = "wss://realtime.example/custom/path/?api-version=2026-07-01/";
    expect(loadConfig({ OPENAI_REALTIME_BASE_URL: baseUrl }).openai.baseUrl).toBe(baseUrl);
    for (const configured of [
      "https://realtime.example/v1/realtime",
      "ftp://realtime.example/v1/realtime",
      "wss://user:secret@realtime.example/v1/realtime",
      "wss://realtime.example/v1/realtime#fragment",
      " wss://realtime.example/v1/realtime",
      "wss://realtime.example\\@attacker.example/v1/realtime",
      `wss://${"x".repeat(2_048)}`,
    ]) {
      expect(() => loadConfig({ OPENAI_REALTIME_BASE_URL: configured })).toThrow();
    }
  });

  it("accepts only canonical Google Cloud endpoint and API-version inputs", () => {
    expect(loadConfig({
      GOOGLE_CLOUD_PROJECT: "demo-project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_GENAI_API_VERSION: "v1beta1",
    }).gemini).toMatchObject({
      project: "demo-project",
      location: "us-central1",
      apiVersion: "v1beta1",
    });
    expect(loadConfig({ GOOGLE_CLOUD_PROJECT: "" }).gemini.project).toBeUndefined();
    for (const project of ["abcde", "Demo-project", "demo-project-", "demo.example/project"]) {
      expect(() => loadConfig({ GOOGLE_CLOUD_PROJECT: project })).toThrow();
    }
    for (const location of ["US-central1", "us.central1", "us-central1/../../target", "us-central1@target"]) {
      expect(() => loadConfig({ GOOGLE_CLOUD_LOCATION: location })).toThrow();
    }
    for (const apiVersion of ["v0", "../v1beta", "v1/beta", "v1beta?key=secret", `v1${"a".repeat(32)}`]) {
      expect(() => loadConfig({ GOOGLE_GENAI_API_VERSION: apiVersion })).toThrow();
    }
  });

  it("removes URL userinfo, path text, and query values from public configuration output", () => {
    expect(publicBaseUrl("wss://user:password@realtime.example/tenant/path-secret?api-key=secret&name=private"))
      .toBe("wss://realtime.example/[redacted-path]?[redacted]");
    expect(publicBaseUrl("http://user:password@hermes.example"))
      .toBe("http://hermes.example");
    expect(publicBaseUrl("not a URL")).toBe("[invalid-url]");
  });

  it("configures the text size limit", () => {
    const config = loadConfig({ HERMES_LIVE_MAX_TEXT_CHARS: "1234" });

    expect(config.server.maxTextChars).toBe(1234);
  });

  it("keeps configured audio frames compatible with bundled clients", () => {
    expect(loadConfig({ HERMES_LIVE_MAX_AUDIO_BYTES: String(MAX_COMPATIBLE_AUDIO_FRAME_BYTES) }).server.maxAudioBytes)
      .toBe(MAX_COMPATIBLE_AUDIO_FRAME_BYTES);
    expect(() => loadConfig({ HERMES_LIVE_MAX_AUDIO_BYTES: String(MAX_COMPATIBLE_AUDIO_FRAME_BYTES + 1) }))
      .toThrow();
  });

  it("keeps configured text frames compatible with the bounded client queue", () => {
    expect(loadConfig({ HERMES_LIVE_MAX_TEXT_CHARS: String(MAX_COMPATIBLE_TEXT_CHARS) }).server.maxTextChars)
      .toBe(MAX_COMPATIBLE_TEXT_CHARS);
    expect(() => loadConfig({ HERMES_LIVE_MAX_TEXT_CHARS: String(MAX_COMPATIBLE_TEXT_CHARS + 1) }))
      .toThrow();
  });

  it("configures trusted identity and session capacity explicitly", () => {
    const config = loadConfig({
      HERMES_LIVE_PROFILE_ID: "private",
      HERMES_LIVE_USER_LABEL: "alice",
      HERMES_LIVE_TRUST_CLIENT_IDENTITY: "true",
      HERMES_LIVE_MAX_SESSIONS: "3",
    });

    expect(config.server).toMatchObject({
      defaultProfileId: "private",
      defaultUserLabel: "alice",
      trustClientIdentity: true,
      maxSessions: 3,
    });
  });

  it("configures the realtime provider ready timeout", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS: "2500" });

    expect(config.server.providerReadyTimeoutMs).toBe(2500);
  });

  it("configures bounded persistent background-task supervision", () => {
    const config = loadConfig({
      HERMES_LIVE_TASK_STATE_FILE: "/tmp/hermes-live/private-tasks.json",
      HERMES_LIVE_MAX_CONCURRENT_TASKS: "4",
      HERMES_LIVE_MAX_QUEUED_TASKS: "48",
      HERMES_LIVE_TASK_HISTORY_LIMIT: "300",
      HERMES_LIVE_TASK_RETENTION_HOURS: "24",
      HERMES_LIVE_TASK_POLL_INTERVAL_MS: "750",
    });

    expect(config.tasks).toEqual({
      stateFile: "/tmp/hermes-live/private-tasks.json",
      maxConcurrent: 4,
      trustDeclaredReadOnly: false,
      maxQueued: 48,
      historyLimit: 300,
      retentionMs: 24 * 60 * 60 * 1_000,
      pollIntervalMs: 750,
    });
  });

  it("requires an explicit trust opt-in for declared read-only parallelism", () => {
    expect(loadConfig().tasks.trustDeclaredReadOnly).toBe(false);
    expect(loadConfig({ HERMES_LIVE_TRUST_DECLARED_READ_ONLY: "true" }).tasks.trustDeclaredReadOnly).toBe(true);
  });

  it("rejects unsafe or unbounded background-task configuration", () => {
    for (const stateFile of ["relative/tasks.json", " /tmp/tasks.json", "/tmp/tasks.json\n"]) {
      expect(() => loadConfig({ HERMES_LIVE_TASK_STATE_FILE: stateFile })).toThrow();
    }
    expect(() => loadConfig({ HERMES_LIVE_MAX_CONCURRENT_TASKS: "0" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_MAX_CONCURRENT_TASKS: "17" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_MAX_QUEUED_TASKS: "513" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_TASK_HISTORY_LIMIT: "9" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_TASK_RETENTION_HOURS: "0" })).toThrow();
    expect(() => loadConfig({ HERMES_LIVE_TASK_POLL_INTERVAL_MS: "249" })).toThrow();
  });

  it("can disable the built-in browser demo", () => {
    const config = loadConfig({ HERMES_LIVE_DEMO_ENABLED: "false" });

    expect(config.server.demoEnabled).toBe(false);
  });

  it("disables the built-in browser demo by default in production", () => {
    const config = loadConfig({ NODE_ENV: "production" });

    expect(config.server.demoEnabled).toBe(false);
  });

  it("can explicitly enable the built-in browser demo in production", () => {
    const config = loadConfig({ NODE_ENV: "production", HERMES_LIVE_DEMO_ENABLED: "true" });

    expect(config.server.demoEnabled).toBe(true);
  });

  it("redacts unsafe session pieces into stable session keys", () => {
    expect(sanitizeSessionComponent(" Alice Example!!! ")).toBe("alice-example");
    expect(sanitizeSessionComponent("---Alice---Example---")).toBe("alice---example");
    expect(sanitizeSessionComponent("Alice!!!Example")).toBe("alice-example");
    expect(sanitizeSessionComponent(`${"-".repeat(100_000)}Alice`)).toBe("alice");
    expect(makeSessionKey("agent:main:hermes-live", "Default Profile", "Alice Example")).toBe(
      "agent:main:hermes-live:profile:default-profile:user:alice-example",
    );
  });

  it("accepts mock provider without realtime provider credentials", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "mock", HERMES_AGENT_API_SERVER_KEY: "hermes-secret" });

    expect(realtimeProviderConfigured(config)).toBe(true);
    expect(() => assertRuntimeConfig(config)).not.toThrow();
  });

  it("requires Hermes API credentials before serving", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "mock" });

    expect(() => assertRuntimeConfig(config)).toThrow(/HERMES_AGENT_API_SERVER_KEY/);
  });

  it("keeps HERMES_API_KEY as a legacy Hermes API credential alias", () => {
    const legacy = loadConfig({ HERMES_LIVE_PROVIDER: "mock", HERMES_API_KEY: "legacy-secret" });
    const preferred = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_AGENT_API_SERVER_KEY: "primary-secret",
      HERMES_API_KEY: "legacy-secret",
    });

    expect(legacy.hermes.apiKey).toBe("legacy-secret");
    expect(preferred.hermes.apiKey).toBe("primary-secret");
  });

  it("requires gateway auth for network-accessible binds", () => {
    const exposed = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_HOST: "0.0.0.0",
      HERMES_AGENT_API_SERVER_KEY: "hermes-secret",
    });
    const protectedConfig = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_HOST: "0.0.0.0",
      HERMES_AGENT_API_SERVER_KEY: "hermes-secret",
      HERMES_LIVE_AUTH_TOKEN: "gateway-secret-token",
    });
    const explicitUnsafe = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_HOST: "0.0.0.0",
      HERMES_AGENT_API_SERVER_KEY: "hermes-secret",
      HERMES_LIVE_ALLOW_UNAUTHENTICATED: "true",
    });

    expect(() => assertRuntimeConfig(exposed)).toThrow(/HERMES_LIVE_AUTH_TOKEN/);
    expect(() => assertRuntimeConfig(protectedConfig)).not.toThrow();
    expect(() => assertRuntimeConfig(explicitUnsafe)).not.toThrow();
  });

  it("requires strong gateway auth tokens for network-accessible binds", () => {
    const weak = loadConfig({
      HERMES_LIVE_PROVIDER: "mock",
      HERMES_LIVE_HOST: "0.0.0.0",
      HERMES_AGENT_API_SERVER_KEY: "hermes-secret",
      HERMES_LIVE_AUTH_TOKEN: "short",
    });

    expect(() => assertRuntimeConfig(weak)).toThrow(/at least 16 characters/);
  });

  it("requires OpenAI credentials for OpenAI provider", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "openai", HERMES_AGENT_API_SERVER_KEY: "hermes-secret" });

    expect(realtimeProviderConfigured(config)).toBe(false);
    expect(() => assertRuntimeConfig(config)).toThrow(/OPENAI_API_KEY/);
  });

  it("supports explicit OpenAI Realtime model overrides", () => {
    const realtime1 = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_MODEL: "gpt-realtime-1.5" });
    const realtimeAlias = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_MODEL: "gpt-realtime" });
    const realtime2 = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_MODEL: "gpt-realtime-2" });

    expect(realtime1.realtime.model).toBe("gpt-realtime-1.5");
    expect(realtimeAlias.realtime.model).toBe("gpt-realtime");
    expect(realtime2.realtime.model).toBe("gpt-realtime-2");
  });

  it("accepts documented Realtime 2 reasoning efforts and rejects stale values", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_REASONING_EFFORT: "minimal" });

    expect(config.openai.reasoningEffort).toBe("minimal");
    expect(() => loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_REASONING_EFFORT: "none" })).toThrow();
  });

  it("configures OpenAI Realtime turn detection explicitly", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_TURN_DETECTION: "semantic_vad" });

    expect(config.openai.turnDetection).toBe("semantic_vad");
  });

  it("requires a Google Cloud project for Gemini Enterprise mode", () => {
    const missingProject = loadConfig({
      HERMES_LIVE_PROVIDER: "gemini",
      HERMES_AGENT_API_SERVER_KEY: "hermes-secret",
      GOOGLE_GENAI_USE_ENTERPRISE: "true",
    });
    const withProject = loadConfig({
      HERMES_LIVE_PROVIDER: "gemini",
      HERMES_AGENT_API_SERVER_KEY: "hermes-secret",
      GOOGLE_GENAI_USE_ENTERPRISE: "true",
      GOOGLE_CLOUD_PROJECT: "demo-project",
    });

    expect(realtimeProviderConfigured(missingProject)).toBe(false);
    expect(() => assertRuntimeConfig(missingProject)).toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(realtimeProviderConfigured(withProject)).toBe(true);
    expect(() => assertRuntimeConfig(withProject)).not.toThrow();
  });
});
