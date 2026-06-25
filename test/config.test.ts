import { describe, expect, it } from "vitest";
import { assertRuntimeConfig, loadConfig, makeSessionKey, realtimeProviderConfigured, sanitizeSessionComponent } from "../src/config.js";

describe("config", () => {
  it("loads defaults and selects Gemini as the default provider", () => {
    const config = loadConfig({});

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(8788);
    expect(config.server.demoEnabled).toBe(true);
    expect(config.server.allowUnauthenticated).toBe(false);
    expect(config.server.maxTextChars).toBe(20_000);
    expect(config.server.providerReadyTimeoutMs).toBe(15_000);
    expect(config.hermes.baseUrl).toBe("http://127.0.0.1:8642");
    expect(config.hermes.timeoutMs).toBe(30_000);
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

  it("configures the text size limit", () => {
    const config = loadConfig({ HERMES_LIVE_MAX_TEXT_CHARS: "1234" });

    expect(config.server.maxTextChars).toBe(1234);
  });

  it("configures the realtime provider ready timeout", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER_READY_TIMEOUT_MS: "2500" });

    expect(config.server.providerReadyTimeoutMs).toBe(2500);
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

  it("supports Realtime 1 and Realtime 2 model selection through env", () => {
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
