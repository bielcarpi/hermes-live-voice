import type { AppConfig } from "../../config.js";
import type { RealtimeClientCapabilities } from "../../domain/protocol/server-protocol.js";

export function realtimeClientCapabilities(
  config: Pick<AppConfig, "realtime" | "openai">,
): RealtimeClientCapabilities {
  if (config.realtime.provider === "mock") {
    return {
      provider: "mock",
      model: config.realtime.model,
      audio: {
        input: { enabled: false },
        output: { enabled: false },
        turnDetection: "none",
      },
    };
  }
  if (config.realtime.provider === "gemini") {
    return {
      provider: "gemini",
      model: config.realtime.model,
      audio: {
        input: { enabled: true, mimeType: "audio/pcm;rate=16000", recommendedFrameMs: 50 },
        output: { enabled: true, mimeType: "audio/pcm;rate=24000" },
        turnDetection: "provider",
      },
    };
  }
  return {
    provider: "openai",
    model: config.realtime.model,
    audio: {
      input: {
        enabled: true,
        mimeType: openAiAudioMimeType(config.openai.inputAudioFormat),
        recommendedFrameMs: 50,
      },
      output: { enabled: true, mimeType: openAiAudioMimeType(config.openai.outputAudioFormat) },
      turnDetection: config.openai.turnDetection,
    },
  };
}

function openAiAudioMimeType(format: AppConfig["openai"]["inputAudioFormat"]): string {
  if (format === "pcm16") return "audio/pcm;rate=24000";
  return format === "g711_ulaw" ? "audio/pcmu;rate=8000" : "audio/pcma;rate=8000";
}
