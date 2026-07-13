import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { realtimeClientCapabilities } from "../src/application/live-gateway/client-capabilities.js";

describe("realtime client capabilities", () => {
  it("advertises Gemini PCM negotiation", () => {
    expect(realtimeClientCapabilities(config({ provider: "gemini", model: "gemini-live" }))).toEqual({
      provider: "gemini",
      model: "gemini-live",
      audio: {
        input: { enabled: true, mimeType: "audio/pcm;rate=16000", recommendedFrameMs: 50 },
        output: { enabled: true, mimeType: "audio/pcm;rate=24000" },
        turnDetection: "provider",
      },
    });
  });

  it("advertises configured OpenAI G.711 formats without pretending they are PCM", () => {
    const value = config({ provider: "openai", model: "gpt-realtime" });
    value.openai.inputAudioFormat = "g711_ulaw";
    value.openai.outputAudioFormat = "g711_alaw";
    value.openai.turnDetection = "semantic_vad";

    expect(realtimeClientCapabilities(value)).toMatchObject({
      provider: "openai",
      audio: {
        input: { mimeType: "audio/pcmu;rate=8000" },
        output: { mimeType: "audio/pcma;rate=8000" },
        turnDetection: "semantic_vad",
      },
    });
  });
});

function config(realtime: AppConfig["realtime"]): Pick<AppConfig, "realtime" | "openai"> {
  return {
    realtime,
    openai: {
      baseUrl: "wss://api.openai.com/v1/realtime",
      model: "gpt-realtime",
      voice: "marin",
      reasoningEffort: "low",
      turnDetection: "disabled",
      inputAudioFormat: "pcm16",
      outputAudioFormat: "pcm16",
    },
  };
}
