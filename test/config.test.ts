import { describe, expect, it } from "vitest";
import { assertRuntimeConfig, loadConfig, makeSessionKey, realtimeProviderConfigured, sanitizeSessionComponent } from "../src/config.js";

describe("config", () => {
  it("loads defaults and selects Gemini as the default provider", () => {
    const config = loadConfig({});

    expect(config.server.host).toBe("127.0.0.1");
    expect(config.server.port).toBe(8788);
    expect(config.hermes.baseUrl).toBe("http://127.0.0.1:8642");
    expect(config.realtime.provider).toBe("gemini");
    expect(config.realtime.model).toBe(config.gemini.model);
  });

  it("uses PORT over HERMES_LIVE_PORT", () => {
    const config = loadConfig({ PORT: "9000", HERMES_LIVE_PORT: "8788" });

    expect(config.server.port).toBe(9000);
  });

  it("redacts unsafe session pieces into stable session keys", () => {
    expect(sanitizeSessionComponent(" Alice Example!!! ")).toBe("alice-example");
    expect(makeSessionKey("agent:main:hermes-live", "Default Profile", "Alice Example")).toBe(
      "agent:main:hermes-live:profile:default-profile:user:alice-example",
    );
  });

  it("accepts mock provider without external credentials", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "mock" });

    expect(realtimeProviderConfigured(config)).toBe(true);
    expect(() => assertRuntimeConfig(config)).not.toThrow();
  });

  it("requires OpenAI credentials for OpenAI provider", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "openai" });

    expect(realtimeProviderConfigured(config)).toBe(false);
    expect(() => assertRuntimeConfig(config)).toThrow(/OPENAI_API_KEY/);
  });

  it("supports Realtime 1 and Realtime 2 model selection through env", () => {
    const realtime1 = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_MODEL: "gpt-realtime" });
    const realtime2 = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_MODEL: "gpt-realtime-2" });

    expect(realtime1.realtime.model).toBe("gpt-realtime");
    expect(realtime2.realtime.model).toBe("gpt-realtime-2");
  });

  it("configures OpenAI Realtime turn detection explicitly", () => {
    const config = loadConfig({ HERMES_LIVE_PROVIDER: "openai", OPENAI_REALTIME_TURN_DETECTION: "semantic_vad" });

    expect(config.openai.turnDetection).toBe("semantic_vad");
  });
});
