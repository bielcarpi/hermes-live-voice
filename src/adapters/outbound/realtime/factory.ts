import type { AppConfig } from "../../../config.js";
import type { LiveModelAdapter } from "../../../application/live-gateway/ports/realtime-model.port.js";
import { GeminiLiveAdapter } from "./gemini-live.adapter.js";
import { MockLiveAdapter } from "./mock-live.adapter.js";
import { OpenAIRealtimeAdapter } from "./openai-realtime.adapter.js";

export function createLiveModelAdapter(config: AppConfig): LiveModelAdapter {
  switch (config.realtime.provider) {
    case "mock":
      return new MockLiveAdapter();
    case "openai":
      return new OpenAIRealtimeAdapter(config.openai, config.server.providerReadyTimeoutMs);
    case "gemini":
      return new GeminiLiveAdapter(config.gemini);
  }
}
