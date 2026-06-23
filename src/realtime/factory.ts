import type { AppConfig } from "../config.js";
import { GeminiLiveAdapter } from "../gemini/live.js";
import { MockLiveAdapter } from "../gemini/mock.js";
import { OpenAIRealtimeAdapter } from "../openai/realtime.js";
import type { LiveModelAdapter } from "./live.js";

export function createLiveModelAdapter(config: AppConfig): LiveModelAdapter {
  switch (config.realtime.provider) {
    case "mock":
      return new MockLiveAdapter();
    case "openai":
      return new OpenAIRealtimeAdapter(config.openai);
    case "gemini":
      return new GeminiLiveAdapter(config.gemini);
  }
}
